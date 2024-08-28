/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
/* eslint-disable @typescript-eslint/no-explicit-any */

import lodash from "lodash";
import { isDefined } from "./TypeGuards";

export function count2DDictionaryValues(dictionary: { [key: string]: { [key2: string]: any[] } }): {
  [key: string]: { [key2: string]: number };
} {
  return Object.entries(dictionary).reduce((output, [key, innerDict]) => {
    const innerDictOutput = Object.entries(innerDict).reduce((innerOutput, [key2, vals]) => {
      return { ...innerOutput, [key2]: vals.length };
    }, {});
    return { ...output, [key]: innerDictOutput };
  }, {});
}

export function count3DDictionaryValues(
  dictionary: { [key: string]: { [key2: string]: any } },
  innerPropName: string
): { [key: string]: { [key2: string]: number } } {
  return Object.entries(dictionary).reduce((output, [key, innerDict]) => {
    const innerDictOutput = Object.entries(innerDict).reduce((innerOutput, [key2, vals]) => {
      return { ...innerOutput, [key2]: vals[innerPropName].length };
    }, {});
    return { ...output, [key]: innerDictOutput };
  }, {});
}

/**
 * Deletes keys from an object and returns new copy of object without ignored keys
 * @param ignoredKeys
 * @param obj
 * @returns Objects with ignored keys removed
 */
function deleteIgnoredKeys(ignoredKeys: string[], obj: Record<string, unknown>) {
  if (!isDefined(obj)) {
    return;
  }
  const newObj = { ...obj };
  for (const key of ignoredKeys) {
    delete newObj[key];
  }
  return newObj;
}

export function compareResultsAndFilterIgnoredKeys(
  ignoredKeys: string[],
  _objA: Record<string, unknown>,
  _objB: Record<string, unknown>
): boolean {
  // Remove ignored keys from copied objects.
  const filteredA = deleteIgnoredKeys(ignoredKeys, _objA);
  const filteredB = deleteIgnoredKeys(ignoredKeys, _objB);

  // Compare objects without the ignored keys.
  return lodash.isEqual(filteredA, filteredB);
}

export function compareArrayResultsWithIgnoredKeys(ignoredKeys: string[], objA: unknown[], objB: unknown[]): boolean {
  // Remove ignored keys from each element of copied arrays.
  const filteredA = objA?.map((obj) => deleteIgnoredKeys(ignoredKeys, obj as Record<string, unknown>));
  const filteredB = objB?.map((obj) => deleteIgnoredKeys(ignoredKeys, obj as Record<string, unknown>));

  // Compare objects without the ignored keys.
  return isDefined(filteredA) && isDefined(filteredB) && lodash.isEqual(filteredA, filteredB);
}
