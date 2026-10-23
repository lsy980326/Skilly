export function renderComponentTags(item,element) {
  const row=element("p","component-tags");
  const names=item.components?.map(c=>c.name)||[];
  row.textContent=names.length?names.join(" · ")+(item.components_truncated?" · 일부만 표시":""):item.components?"연결 정보 없음":"분류 정보 미표시";
  if(item.component_source==="request_declaration")row.append(element("small",""," · 저장 대기 요청의 선언"));
  if(item.component_source==="installation_binding")row.append(element("small",""," · 설치 연결 설정"));
  if(item.components_partial)row.append(element("small",""," · 일부 항목 미지정"));
  return row;
}
