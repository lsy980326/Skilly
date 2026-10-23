const views=["runs","features","plans","skills","recovery"],values=["active","latest","oldest","name","name_desc"];
const key="skilly.viewer.list-sorting.v1";
export function createListSorting(getStorage) {
  const saved={};
  try { const input=JSON.parse(getStorage().getItem(key)||"{}");for(const view of views)if(values.includes(input?.[view]))saved[view]=input[view]; } catch { /* Sorting remains usable when browser storage is unavailable. */ }
  return {get:view=>saved[view]||"active",set(view,value){if(!views.includes(view)||!values.includes(value))return false;saved[view]=value;try{getStorage().setItem(key,JSON.stringify(saved));}catch{}return true;}};
}
