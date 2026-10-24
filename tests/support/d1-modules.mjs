import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Miniflare is not a package bundler. Supply the installed ESM graph explicitly, resolving
// only the existing Zod package. Implementation is unchanged; no download or generated files.
export function d1WorkerModules(entry) {
  const root = fileURLToPath(new URL('../../', import.meta.url)), modules = [], visited = new Set();
  function visit(path) {
    if (visited.has(path)) return;
    visited.add(path);
    let contents = readFileSync(path, 'utf8');
    const dependencies = [];
    const source = ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
    for (const statement of source.statements) {
      if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
        || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      const dependency = specifier.startsWith('.') ? resolve(dirname(path), specifier)
        : specifier === 'zod' ? fileURLToPath(import.meta.resolve('zod')) : null;
      if (!dependency || relative(root, dependency).startsWith('..')) throw Error(`Unsupported local test module: ${specifier}`);
      dependencies.push(dependency);
      if (!specifier.startsWith('.')) {
        const resolved = './' + relative(dirname(path), dependency).replaceAll('\\', '/');
        contents = contents.replaceAll(`'${specifier}'`, JSON.stringify(resolved)).replaceAll(`"${specifier}"`, JSON.stringify(resolved));
      }
    }
    modules.push({ type: 'ESModule', path, contents });
    for (const dependency of dependencies) visit(dependency);
  }
  visit(entry);
  return { modules, modulesRoot: root };
}
