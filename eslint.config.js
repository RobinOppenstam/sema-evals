import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "coverage/**",
      "results/**",
      ".cache/**",
      // Executable acquisition evidence runs against upstream module formats
      // and is independently hashed/reviewed rather than transformed by lint.
      "experiments/workflow-value/acquisition/tasks/**/*.cjs",
      "experiments/workflow-value/acquisition/tasks/**/*.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
);
