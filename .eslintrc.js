module.exports = {
  env: {
    browser: false,
    es2021: true,
    mocha: true,
    node: true,
  },
  plugins: ["n", "prettier", "@typescript-eslint", "mocha", "chai-expect"],
  extends: [
    "plugin:prettier/recommended",
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:@typescript-eslint/eslint-recommended",
    "plugin:n/recommended",
  ],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 12,
    project: "./tsconfig.eslint.json",
  },
  rules: {
    "prettier/prettier": ["warn"],
    indent: 0, // avoid conflict with prettier's indent system
    "linebreak-style": ["error", "unix"],
    quotes: ["error", "double", { avoidEscape: true }],
    semi: ["error", "always"],
    curly: ["error", "all"],
    "spaced-comment": ["error", "always", { exceptions: ["-", "+"] }],
    "no-console": 2,
    camelcase: "off",
    "@typescript-eslint/camelcase": "off",
    "mocha/no-exclusive-tests": "error",
    "@typescript-eslint/no-require-imports": "off",
    "n/no-missing-import": "off", // TypeScript handles import resolution
    "n/no-process-exit": "off",
    "n/no-unsupported-features/es-syntax": ["error", { ignores: ["modules"] }],
    "@typescript-eslint/no-explicit-any": "error",
    // Disable warnings for { a, b, ...rest } variables, since this is typically used to remove variables.
    "@typescript-eslint/no-unused-vars": [
      "error",
      { ignoreRestSiblings: true, argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
    ],
    "chai-expect/missing-assertion": 2,
    "no-duplicate-imports": "error",
    "@typescript-eslint/no-floating-promises": ["error"],
    "@typescript-eslint/no-misused-promises": ["error"],
    "@typescript-eslint/await-thenable": ["error"],
    "@typescript-eslint/require-array-sort-compare": ["error"],
    "@typescript-eslint/no-unnecessary-type-assertion": ["error"],
    "@typescript-eslint/no-non-null-assertion": ["error"],
    "@typescript-eslint/no-redundant-type-constituents": ["error"],
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          { group: ["@ethersproject/bignumber"], message: "Use 'src/utils/BNUtils' instead" },
          { group: ["hardhat"], message: "Use 'src/utils or 'ethers'' instead" },
        ],
        paths: [
          { name: "ethers", importNames: ["BigNumber"], message: "Use 'src/utils/BNUtils' instead" },
          { name: "ethers", importNames: ["Event"], message: "Use Log from 'src/interfaces/Common' instead" },
        ],
      },
    ],
  },
  settings: {
    node: {
      tryExtensions: [".js", ".ts"],
    },
  },
  overrides: [
    {
      files: ["scripts/*.ts", "tasks/*.ts", "src/scripts/*.ts"],
      rules: {
        "no-console": 0,
      },
    },
    {
      files: ["test/**/*.ts", "hardhat.config.ts", "tasks/*.ts"],
      rules: {
        "no-restricted-imports": "off",
      },
    },
    {
      files: ["test/**/*.ts"],
      rules: {
        "@typescript-eslint/no-unused-expressions": "off", // Chai assertions are "unused expressions"
      },
    },
    {
      // libexec runs as one forked subprocess per chain, so its module graph is resident
      // ~35 times over on a full deployment. Barrel imports pull the whole re-export graph
      // (src/utils/index.ts alone re-exports 46 modules and the @across-protocol/sdk root),
      // which is why these entrypoints cost ~250MB each. Import the defining module instead.
      // Everywhere else the barrels remain the convenient default.
      files: ["src/libexec/**/*.ts"],
      rules: {
        // The TS variant so `allowTypeImports` is available: `import type` is erased at compile
        // time and costs nothing at runtime, so only value imports of the barrels are worth
        // banning. The base no-restricted-imports config is inherited unchanged.
        "@typescript-eslint/no-restricted-imports": [
          "error",
          {
            // `paths` matches the specifier exactly, so only the barrels themselves are caught;
            // '../utils/TypeGuards' and friends stay allowed. (`patterns` would prefix-match and
            // reject the leaf imports too.)
            paths: [
              "../utils",
              "../clients",
              "../interfaces",
              "../common",
              "../../utils",
              "../../clients",
              "../../interfaces",
              "../../common",
              "../../../utils",
              "../../../clients",
              "../../../interfaces",
              "../../../common",
            ].map((name) => ({
              name,
              allowTypeImports: true,
              message:
                "libexec is forked per-chain; barrel imports load the whole graph. Import the defining module, e.g. '../utils/TypeGuards'.",
            })),
          },
        ],
      },
    },
  ],
};
