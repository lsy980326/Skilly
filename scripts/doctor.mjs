import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { diagnoseInstallation, diagnoseExecutionAccess } from './local-installation.mjs';

// No config/auth contents, network, writer connection, automatic repair or model turn.
function regular(path) {
  let current = path;
  while (true) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (current === path ? !stat.isFile() : !stat.isDirectory())) throw new Error('Unsafe path');
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}
function state(path) {
  try { regular(path); return 'present'; }
  catch (error) { return error?.code === 'ENOENT' ? 'missing' : 'unavailable'; }
}
export async function diagnoseLocal({ project, db, installation }) {
  if (!isAbsolute(project) || !isAbsolute(db)) throw new Error('Use absolute --project and --db paths.');
  if (installation && !isAbsolute(installation)) throw new Error('Use an absolute installation data path.');
  const root = realpathSync(project), checks = [];
  const add = (key, status, detail) => checks.push({ key, status, detail });
  const ready = state(fileURLToPath(new URL('../dist/runtime/local/main.js', import.meta.url))) === 'present' && Number(process.versions.node.split('.')[0]) >= 24;
  add('runtime', ready ? 'ready' : 'action_required', ready ? 'Node와 Skilly 실행 파일이 준비됐습니다.' : 'Node.js 24 이상과 npm run build가 필요합니다.');
  let binding;
  try { const { loadProjectBinding } = await import('../dist/adapters/project/binding.js'); regular(join(root,'skilly.project.json')); binding = loadProjectBinding(root); add('identity','ready','프로젝트 식별 파일이 유효합니다.'); }
  catch { add('identity','action_required','프로젝트 식별 파일이 없거나 올바르지 않습니다. 첫 설치 시 명시적인 이름과 키를 지정하세요.'); }
  for (const [key,path,label] of [
    ['mcp_config','.codex/config.toml','MCP 설정 파일'],
    ['skill','.agents/skills/use-skilly/SKILL.md','use-skilly 전문'],
    ['skill_metadata','.agents/skills/use-skilly/agents/openai.yaml','스킬 도구 연결 안내 파일'],
  ]) {
    const status = state(join(root,path));
    add(key,status === 'present' ? 'present_unverified' : 'action_required', status === 'present'
      ? `${label}이 있습니다. 내용·호스트 로딩·연결 성공을 확인한 것은 아닙니다.` : `${label}이 없거나 안전하게 확인할 수 없습니다. 기존 파일은 덮어쓰지 마세요.`);
  }
  const installed = diagnoseInstallation(root, db, installation);
  add('execution_paths', installed.status === 'paths_match' ? 'ready' : installed.status === 'missing' && !installation ? 'present_unverified' : 'action_required',
    installed.status === 'paths_match' ? '설치 경로가 현재 경로와 일치합니다. 실제 연결이나 쓰기 성공을 뜻하지 않습니다.'
    : installed.status === 'missing' ? '실행 경로 안내가 없습니다. 기존 설정을 읽거나 경로를 추측하지 마세요.'
    : '설치 경로가 이동했거나 실행 파일을 확인할 수 없습니다. 기존 설정을 보존하고 --output으로 새 연결 후보를 만드세요.');
  const executionAccess = diagnoseExecutionAccess(db);
  add('execution_access', executionAccess.status === 'appears_writable' ? 'present_unverified' : 'action_required',
    executionAccess.status === 'appears_writable' ? '현재 프로세스의 DB·폴더 접근 사전 확인만 통과했습니다. Codex 샌드박스 승인과 실제 저장은 별도입니다.'
    : 'DB·부모 폴더·WAL/SHM 파일 접근이 제한되거나 경로가 올바르지 않습니다. 권한을 자동 확대하지 말고 호스트 승인 절차를 확인하세요.');
  let database = { status: 'not_checked', project_registered: false };
  const dbState = state(db);
  if (dbState === 'missing') { database.status = 'not_initialized'; add('database','not_initialized','DB가 아직 없습니다. 첫 MCP 연결에서 생성할 수 있습니다. 진단은 생성하지 않습니다.'); }
  else if (dbState !== 'present') { database.status = 'unavailable'; add('database','action_required','DB 경로·링크·파일 상태를 확인하세요. 진단은 파일을 바꾸지 않았습니다.'); }
  else {
    let reader;
    try {
      reader = new DatabaseSync(db,{readOnly:true});reader.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250;');
      const version=reader.prepare('PRAGMA user_version').get().user_version;
      if(reader.prepare('PRAGMA application_id').get().application_id !== 1397446988 || ![1,2,3,4,5,6,7,8,9,10,11,12,13,14].includes(version)) throw new Error('Unsupported DB');
      const row=binding ? reader.prepare('SELECT id,name FROM projects WHERE project_key=?').get(binding.key) : undefined;
      if(row && row.name !== binding.name) throw new Error('Project mismatch');
      database={status:'readable',schema_version:version,project_registered:Boolean(row)};
      add('database','ready',row ? 'DB를 읽기 전용으로 열고 이 프로젝트 등록을 확인했습니다.' : 'DB를 읽을 수 있습니다. 이 프로젝트 등록 여부는 첫 연결에서 확인하세요.');
    } catch { database.status='unavailable';add('database','action_required','DB를 읽지 못하거나 프로젝트 식별이 다릅니다. DB를 초기화·교체하지 말고 경로와 잠금 상태를 확인하세요.'); }
    finally { reader?.close(); }
  }
  return { status:checks.some(c=>c.status === 'action_required') ? 'action_required' : 'local_preflight_ready', checks, database,
    installation: installed, execution_access: executionAccess,
    connection_status:'not_checked', trust_status:'unknown', current_chat_tools:'unknown', configuration_contents_read:false,
    files_changed:false, next_steps:[
      '처음 설치하지 않았다면 npm run setup:codex 안내를 따르세요. 기존 설정이 있으면 설치를 반복하거나 덮어쓰지 마세요.',
      'Codex에서 이 폴더를 열고 실제 신뢰 확인이 나오면 사용자가 확인하세요. 진단은 신뢰 설정을 바꾸지 않습니다.',
      '새 채팅에서 실제 memory_resolve_project와 이전 기록 조회 성공을 확인하세요. 별도 진단 프로세스의 성공과 현재 채팅 연결은 다릅니다.',
      'MCP 도구가 없을 때만 지원되는 서버 Restart 후 한 번 재확인하세요. 이미 호출이 성공하면 반복 재시작하지 마세요.',
      'stdio MCP는 Codex가 필요할 때 실행합니다. 로컬 화면 서버는 별도이며 화면 연결 실패가 MCP 장애라는 뜻은 아닙니다.',
    ] };
}
if(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 try {
  const {values}=parseArgs({options:{project:{type:'string'},db:{type:'string'},installation:{type:'string'}}});
  if(!values.project || !values.db) throw new Error('Usage: npm run doctor -- --project /absolute/project --db /absolute/memory.sqlite');
  const result=await diagnoseLocal(values);process.stdout.write(JSON.stringify(result,null,2)+'\n');
  if(result.status === 'action_required')process.exitCode=1;
 } catch { process.stderr.write('진단하지 못했습니다. 절대 경로의 프로젝트 폴더와 DB 경로를 확인하세요. 파일은 변경하지 않았습니다.\n');process.exitCode=1; }
}
