/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
/* eslint-disable @typescript-eslint/no-explicit-any */
// Append value along the keyPath to object. For example assign(deposits, ['1337', '31337'], [{depositId:1}]) will create
// deposits = {1337:{31337:[{depositId:1}]}}. Note that if the path into the object exists then this will append. This
// function respects the destination type; if it is an object then deep merge and if an array effectively will push.
export function assign(obj: any, keyPath: any[], value: any): void {
  const lastKeyIndex = keyPath.length - 1;
  for (let i = 0; i < lastKeyIndex; ++i) {
    const key = keyPath[i];
    if (!(key in obj)) {
      obj[key] = {};
    }
    obj = obj[key];
  }
  // If the object at the deep path does not exist then set to the value.
  if (!obj[keyPath[lastKeyIndex]] || typeof obj[keyPath[lastKeyIndex]] == "string") {
    obj[keyPath[lastKeyIndex]] = value;
  }
  // If the object at the deep path is an array then append array wise.
  else if (Array.isArray(value)) {
    obj[keyPath[lastKeyIndex]] = [...obj[keyPath[lastKeyIndex]], ...value];
  }
  // If the value is false bool then set to false. This special case is needed as {...false} = {} which causes issues.
  else if (value === false) {
    obj[keyPath[lastKeyIndex]] = false;
  }
  // If the object at the deep path is an object then append object wise.
  else {
    obj[keyPath[lastKeyIndex]] = { ...obj[keyPath[lastKeyIndex]], ...value };
  }
}

// Refactor to be more generalized with N props
export function groupObjectCountsByThreeProps(
  objects: any[],
  primaryProp: string,
  secondaryProp: string,
  tertiaryProp: string
): any {
  return objects.reduce((result, obj) => {
    result[obj[primaryProp]] = result[obj[primaryProp]] ?? {};
    result[obj[primaryProp]][obj[secondaryProp]] = result[obj[primaryProp]][obj[secondaryProp]] ?? {};
    const existingCount = result[obj[primaryProp]][obj[secondaryProp]][obj[tertiaryProp]];
    result[obj[primaryProp]][obj[secondaryProp]][obj[tertiaryProp]] =
      existingCount === undefined ? 1 : existingCount + 1;
    return result;
  }, {});
}
export function groupObjectCountsByTwoProps(
  objects: any[],
  primaryProp: string,
  getSecondaryProp: (obj: any) => string
): any {
  return objects.reduce((result, obj) => {
    result[obj[primaryProp]] = result[obj[primaryProp]] ?? {};
    const existingCount = result[obj[primaryProp]][getSecondaryProp(obj)];
    result[obj[primaryProp]][getSecondaryProp(obj)] = existingCount === undefined ? 1 : existingCount + 1;
    return result;
  }, {});
}

export function groupObjectCountsByProp(objects: any[], getProp: (obj: any) => string): any {
  return objects.reduce((result, obj) => {
    const existingCount = result[getProp(obj)];
    result[getProp(obj)] = existingCount === undefined ? 1 : existingCount + 1;
    return result;
  }, {});
}
