import { TransformResult, createUnplugin } from 'unplugin';
import civet, { SourceMap } from '@danielx/civet';
import {
  remapRange,
  flattenDiagnosticMessageText,
  // @ts-ignore
  // using ts-ignore because the version of @danielx/civet typescript is checking against
  // is the one published to npm, not the one in the repo
} from '@danielx/civet/ts-diagnostic';
import * as fs from 'fs';
import path from 'path';
import type { FormatDiagnosticsHost, Diagnostic, System } from 'typescript';
import * as tsvfs from '@typescript/vfs';
import type { UserConfig } from 'vite';
import type { BuildOptions } from 'esbuild';
import os from 'os';

export type PluginOptions = {
  implicitExtension?: boolean;
  outputExtension?: string;
  transformOutput?: (
    code: string,
    id: string
  ) => TransformResult | Promise<TransformResult>;
  emitDeclaration?: boolean;
  typecheck?: boolean;
  ts?: 'civet' | 'esbuild' | 'tsc' | 'preserve';
  /** @deprecated Use "ts" option instead */
  js?: boolean;
  /** @deprecated Use "emitDeclaration" instead */
  dts?: boolean;
};

const isCivetTranspiled = (id: string) => /\.civet\.[jt]sx([?#].*)?$/.test(id);
const postfixRE = /[?#].*$/s;
const isWindows = os.platform() === 'win32';
const windowsSlashRE = /\\/g;

// removes query string, hash and tsx/jsx extension
function cleanCivetId(id: string): string {
  return id.replace(postfixRE, '').replace(/\.[jt]sx$/, '');
}

function tryStatSync(file: string): fs.Stats | undefined {
  try {
    // The "throwIfNoEntry" is a performance optimization for cases where the file does not exist
    return fs.statSync(file, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

export function slash(p: string): string {
  return p.replace(windowsSlashRE, '/');
}

function normalizePath(id: string): string {
  return path.posix.normalize(isWindows ? slash(id) : id);
}

function tryFsResolve(file: string): string | undefined {
  const fileStat = tryStatSync(file);
  if (fileStat?.isFile()) return normalizePath(file);

  return undefined;
}

function resolveAbsolutePath(rootDir: string, id: string, implicitExtension: boolean) {
  const file = path.join(rootDir, id);
  // Check for existence of resolved file and unsolved id,
  // without and with implicit .civet extension, and return first existing
  return tryFsResolve(file) ||
    (implicitExtension && implicitCivet(file)) ||
    tryFsResolve(id) ||
    (implicitExtension && implicitCivet(id));
}

function implicitCivet(file: string): string | undefined {
  if (tryFsResolve(file)) return
  const civet = file + '.civet'
  if (tryFsResolve(civet)) return civet
  return
}

const civetUnplugin = createUnplugin((options: PluginOptions = {}, meta) => {
  if (options.dts) options.emitDeclaration = options.dts;
  if (options.js) options.ts = 'civet';

  const transformTS = options.emitDeclaration || options.typecheck;
  const outExt =
    options.outputExtension ?? (options.ts === 'preserve' ? '.tsx' : '.jsx');
  const implicitExtension = options.implicitExtension ?? true;

  let fsMap: Map<string, string> = new Map();
  const sourceMaps = new Map<string, SourceMap>();
  let compilerOptions: any;
  let rootDir = process.cwd();
  let esbuildOptions: BuildOptions;

  const tsPromise =
    transformTS || options.ts === 'tsc'
      ? import('typescript').then(m => m.default)
      : null;
  const getFormatHost = (sys: System): FormatDiagnosticsHost => {
    return {
      getCurrentDirectory: () => sys.getCurrentDirectory(),
      getNewLine: () => sys.newLine,
      getCanonicalFileName: sys.useCaseSensitiveFileNames
        ? f => f
        : f => f.toLowerCase(),
    };
  };

  return {
    name: 'unplugin-civet',
    enforce: 'pre',
    async buildStart() {
      if (transformTS || options.ts === 'tsc') {
        const ts = await tsPromise!;

        const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists);

        if (!configPath) {
          throw new Error("Could not find 'tsconfig.json'");
        }

        const { config, error } = ts.readConfigFile(
          configPath,
          ts.sys.readFile
        );

        if (error) {
          console.error(ts.formatDiagnostic(error, getFormatHost(ts.sys)));
          throw error;
        }

        const configContents = ts.parseJsonConfigFileContent(
          config,
          ts.sys,
          process.cwd()
        );

        compilerOptions = {
          ...configContents.options,
          target: ts.ScriptTarget.ESNext,
        };
        fsMap = new Map();
      }
    },
    async buildEnd() {
      if (transformTS) {
        const ts = await tsPromise!;

        const system = tsvfs.createFSBackedSystem(fsMap, process.cwd(), ts);
        const host = tsvfs.createVirtualCompilerHost(
          system,
          compilerOptions,
          ts
        );
        const program = ts.createProgram({
          rootNames: [...fsMap.keys()],
          options: compilerOptions,
          host: host.compilerHost,
        });

        const diagnostics: Diagnostic[] = ts
          .getPreEmitDiagnostics(program)
          .map(diagnostic => {
            const file = diagnostic.file;
            if (!file) return diagnostic;

            const sourceMap = sourceMaps.get(file.fileName);
            if (!sourceMap) return diagnostic;

            const sourcemapLines = sourceMap.data.lines;
            const range = remapRange(
              {
                start: diagnostic.start || 0,
                end: (diagnostic.start || 0) + (diagnostic.length || 1),
              },
              sourcemapLines
            );

            return {
              ...diagnostic,
              messageText: flattenDiagnosticMessageText(diagnostic.messageText),
              length: diagnostic.length,
              start: range.start,
            };
          });

        if (diagnostics.length > 0) {
          console.error(
            ts.formatDiagnosticsWithColorAndContext(
              diagnostics,
              getFormatHost(ts.sys)
            )
          );
        }

        if (options.emitDeclaration) {
          if (meta.framework === 'esbuild' && !esbuildOptions.outdir) {
            console.log("WARNING: Civet unplugin's `emitDeclaration` requires esbuild's `outdir` option to be set;");
          }

          // Removed duplicate slashed (`\`) versions of the same file for emit
          for (const file of fsMap.keys()) {
            const slashed = slash(file);
            if (file !== slashed) {
              fsMap.delete(slashed);
            }
          }
          for (const file of fsMap.keys()) {
            const sourceFile = program.getSourceFile(file)!;
            program.emit(
              sourceFile,
              (filePath, content) => {
                const pathFromDistDir = path.relative(
                  compilerOptions.outDir ?? process.cwd(),
                  filePath
                );

                this.emitFile({
                  source: content,
                  fileName: pathFromDistDir,
                  type: 'asset',
                });
              },
              undefined,
              true
            );
          }
        }
      }
    },
    resolveId(id, importer) {
      if (/\0/.test(id)) return null;

      id = cleanCivetId(id);
      const absolutePath = path.isAbsolute(id)
        ? resolveAbsolutePath(rootDir, id, implicitExtension)
        : path.resolve(path.dirname(importer ?? ''), id);
      if (!absolutePath) return null;

      let relativeId = path.relative(process.cwd(), absolutePath);

      // Implicit .civet extension
      if (!relativeId.endsWith('.civet')) {
        if (!implicitExtension) return null;
        const implicitId = implicitCivet(relativeId)
        if (!implicitId) return null;
        relativeId = implicitId
      }

      const relativePath = relativeId + outExt;
      return relativePath;
    },
    loadInclude(id) {
      return isCivetTranspiled(id);
    },
    async load(id) {
      if (!isCivetTranspiled(id)) return null;

      const filename = path.resolve(process.cwd(), id.slice(0, -outExt.length));
      const rawCivetSource = await fs.promises.readFile(filename, 'utf-8');
      this.addWatchFile(filename);

      let compiled: {
        code: string;
        sourceMap: SourceMap | string;
      } = undefined!;

      if (options.ts === 'civet' && !transformTS) {
        compiled = civet.compile(rawCivetSource, {
          filename: id,
          js: true,
          sourceMap: true,
        });
      } else {
        const compiledTS = civet.compile(rawCivetSource, {
          filename: id,
          js: false,
          sourceMap: true,
        });

        const resolved = path.resolve(process.cwd(), id);
        sourceMaps.set(
          resolved,
          compiledTS.sourceMap as SourceMap
        );

        if (transformTS) {
          fsMap.set(resolved, compiledTS.code);
          // Vite and Rollup normalize filenames to use `/` instead of `\`.
          // We give the TypeScript VFS both versions just in case.
          const slashed = slash(resolved);
          if (resolved !== slashed) fsMap.set(slashed, compiledTS.code);
        }

        switch (options.ts) {
          case 'esbuild': {
            const esbuildTransform = (await import('esbuild')).transform;
            const result = await esbuildTransform(compiledTS.code, {
              jsx: 'preserve',
              loader: 'tsx',
              sourcefile: id,
              sourcemap: 'external',
            });

            compiled = { code: result.code, sourceMap: result.map };
            break;
          }
          case 'tsc': {
            const tsTranspile = (await tsPromise!).transpileModule;
            const result = tsTranspile(compiledTS.code, { compilerOptions });

            compiled = {
              code: result.outputText,
              sourceMap: result.sourceMapText ?? '',
            };
            break;
          }
          case 'preserve': {
            compiled = compiledTS;
            break;
          }
          case 'civet':
          default: {
            compiled = civet.compile(rawCivetSource, {
              filename: id,
              js: true,
              sourceMap: true,
            });

            if (options.ts == undefined) {
              console.log(
                'WARNING: You are using the default mode for `options.ts` which is `"civet"`. This mode does not support all TS features. If this is intentional, you should explicitly set `options.ts` to `"civet"`, or choose a different mode.'
              );
            }

            break;
          }
        }
      }

      const jsonSourceMap =
        typeof compiled.sourceMap == 'string'
          ? JSON.parse(compiled.sourceMap)
          : compiled.sourceMap.json(
              path.basename(id.replace(/\.[jt]sx$/, '')),
              path.basename(id)
            );

      let transformed: TransformResult = {
        code: compiled.code,
        map: jsonSourceMap,
      };

      if (options.transformOutput)
        transformed = await options.transformOutput(transformed.code, id);

      return transformed;
    },
    esbuild: {
      config(options: BuildOptions) {
        esbuildOptions = options;
      },
    },
    vite: {
      config(config: UserConfig) {
        rootDir = path.resolve(process.cwd(), config.root ?? '');

        if (implicitExtension) {
          config.resolve ??= {};
          config.resolve.extensions ??= [];
          config.resolve.extensions.push('.civet');
        }
      },
      async transformIndexHtml(html) {
        return html.replace(/<!--[^]*?-->|<[^<>]*>/g, tag =>
          tag.replace(/<\s*script\b[^<>]*>/gi, script =>
            // https://html.spec.whatwg.org/multipage/syntax.html#attributes-2
            script.replace(
              /([:_\p{ID_Start}][:\p{ID_Continue}]*)(\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]*))?/gu,
              (attr, name, value) =>
                name.toLowerCase() === 'src' && value
                  ? attr.replace(
                      /(\.civet)(['"]?)$/,
                      (_, extension, endQuote) =>
                        `${extension}${outExt}?transform${endQuote}`
                    )
                  : attr
            )
          )
        );
      },
      handleHotUpdate({ file, server, modules }) {
        // `file` is an absolute path to the changed file on disk,
        // so for our case it should end with .civet extension
        if (!file.endsWith('.civet')) return;
        // Convert into relative path as would be output by `resolveId`
        const relativeId = slash(path.relative(process.cwd(), file) + outExt);
        // Check for module with this name
        const module = server.moduleGraph.getModuleById(relativeId);
        if (module) {
          // Invalidate modules depending on this one
          server.moduleGraph.onFileChange(relativeId);
          // Hot reload this module
          return [ ...modules, module ]
        }
        return modules;
      },
    },
  };
});

export default civetUnplugin;
