"use strict";

// Forbid `process.env.X` reads at module load time. dotenv runs at the
// top-level entry point, so any read evaluated before its imports finish
// resolving will see an unloaded environment. Reads inside function bodies
// are safe.
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow reading process.env at module top level (before dotenv has loaded).",
    },
    schema: [],
    messages: {
      topLevelRead:
        "Don't read process.env at module load time. " +
        "dotenv is loaded by the entry point and may not have run yet — read it inside a function instead.",
    },
  },
  create(context) {
    return {
      "MemberExpression[object.name='process'][property.name='env']"(node) {
        const inFunction = context.getAncestors().some((ancestor) => {
          switch (ancestor.type) {
            case "FunctionDeclaration":
            case "FunctionExpression":
            case "ArrowFunctionExpression":
              return true;
            default:
              return false;
          }
        });
        if (!inFunction) {
          context.report({ node, messageId: "topLevelRead" });
        }
      },
    };
  },
};
