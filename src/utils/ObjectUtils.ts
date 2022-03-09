// Append value along the keyPath to object. For example assign(deposits, ['1337', '31337'], [{depositId:1}]) will create
// deposits = {1337:{31337:[{depositId:1}]}}. Note that if the path into the object exists then this will append. This
// function respects the destination type; if it is an object then deep merge and if an array effectively will push.
export function assign(obj: any, keyPath: any[], value: any) {
  const lastKeyIndex = keyPath.length - 1;
  for (let i = 0; i < lastKeyIndex; ++i) {
    const key = keyPath[i];
    if (!(key in obj)) obj[key] = {};
    obj = obj[key];
  }
  // If the object at the deep path does not exist then set to the value.
  if (!obj[keyPath[lastKeyIndex]]) obj[keyPath[lastKeyIndex]] = value;
  // If the object at the deep path is an array then append array wise.
  else if (Array.isArray(value)) obj[keyPath[lastKeyIndex]] = [...obj[keyPath[lastKeyIndex]], ...value];
  // If the object at the deep path is an object then append object wise.
  else obj[keyPath[lastKeyIndex]] = { ...obj[keyPath[lastKeyIndex]], ...value };
}
