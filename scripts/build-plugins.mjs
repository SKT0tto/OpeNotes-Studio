// Builds every plugin in plugins/<id>/ in place: src/server.ts -> server.mjs (Node, npm packages stay external: the studio's node_modules
// provides express / zod), src/web.tsx -> web.js (browser ESM; `react`, `react/jsx-runtime` and `react-dom` come from the studio through
// window.__OPENOTES_HOST__, so the plugin and the editor share ONE React). Usage: node scripts/build-plugins.mjs [id ...]
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const pluginsDir = path.join(root, 'plugins');

const REACT_NAMES = ['Children', 'Component', 'Fragment', 'Profiler', 'PureComponent', 'StrictMode', 'Suspense', 'cloneElement', 'createContext', 'createElement', 'createRef', 'forwardRef', 'isValidElement', 'lazy', 'memo', 'startTransition', 'use', 'useActionState', 'useCallback', 'useContext', 'useDebugValue', 'useDeferredValue', 'useEffect', 'useId', 'useImperativeHandle', 'useInsertionEffect', 'useLayoutEffect', 'useMemo', 'useOptimistic', 'useReducer', 'useRef', 'useState', 'useSyncExternalStore', 'useTransition', 'version'];
const SHIMS = {
  react: `const R = window.__OPENOTES_HOST__.React;\nexport default R;\n${REACT_NAMES.map((n) => `export const ${n} = R.${n};`).join('\n')}\n`,
  'react/jsx-runtime': 'const J = window.__OPENOTES_HOST__.jsxRuntime;\nexport const jsx = J.jsx, jsxs = J.jsxs, Fragment = J.Fragment;\n',
  'react-dom': 'const D = window.__OPENOTES_HOST__.ReactDOM;\nexport default D;\nexport const createPortal = D.createPortal, flushSync = D.flushSync;\n',
};
const hostShims = {
  name: 'host-react',
  setup(b) {
    b.onResolve({ filter: /^(react|react\/jsx-runtime|react-dom)$/ }, (a) => ({ path: a.path, namespace: 'host-shim' }));
    b.onLoad({ filter: /.*/, namespace: 'host-shim' }, (a) => ({ contents: SHIMS[a.path], loader: 'js' }));
  },
};

/** Builds one plugin; returns the files it made. */
export async function buildPlugin(id) {
  const dir = path.join(pluginsDir, id);
  const made = [];
  const server = path.join(dir, 'src', 'server.ts');
  const web = path.join(dir, 'src', 'web.tsx');
  if (fs.existsSync(server)) {
    await build({ entryPoints: [server], outfile: path.join(dir, 'server.mjs'), bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22', logLevel: 'warning' });
    made.push('server.mjs');
  }
  if (fs.existsSync(web)) {
    await build({
      entryPoints: [web], outfile: path.join(dir, 'web.js'), bundle: true, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic', minify: true,
      plugins: [hostShims], logLevel: 'warning',
    });
    made.push('web.js');
  }
  return made;
}

export function pluginIds() {
  if (!fs.existsSync(pluginsDir)) return [];
  return fs.readdirSync(pluginsDir, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(pluginsDir, d.name, 'plugin.json'))).map((d) => d.name).sort();
}

if (process.argv[1]?.endsWith('build-plugins.mjs')) {
  const ids = process.argv.slice(2).length > 0 ? process.argv.slice(2) : pluginIds();
  for (const id of ids) console.log(`plugin ${id}: ${(await buildPlugin(id)).join(', ') || 'nothing to build'}`);
}
