import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Build output and generated files are never linted: `tsc -b`/`vite build`
  // artefacts (dist), Capacitor's synced web assets and Gradle's intermediates
  // (native-bridge.js lives in there) are machine-generated and would
  // otherwise fail `eslint .`.
  globalIgnores([
    'node_modules/**',
    'dist/**',
    'frontend/dist/**',
    'android/**/build/**',
    'frontend/android/**/build/**',
    'android/**/assets/public/**',
    'frontend/android/**/assets/public/**',
    'release/**',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
])
