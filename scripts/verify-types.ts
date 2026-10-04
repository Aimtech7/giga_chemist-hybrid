import ts from 'typescript';
import path from 'path';

function runTypeCheck() {
  console.log('Running TypeScript Typecheck via TS API...');
  const configPath = ts.findConfigFile('./', ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) {
    console.error('Could not find a valid "tsconfig.json".');
    process.exit(1);
  }

  const readConfigFileResult = ts.readConfigFile(configPath, ts.sys.readFile);
  if (readConfigFileResult.error) {
    console.error('Error reading tsconfig.json:', readConfigFileResult.error);
    process.exit(1);
  }

  const parsedCommandLine = ts.parseJsonConfigFileContent(
    readConfigFileResult.config,
    ts.sys,
    path.dirname(configPath)
  );

  const program = ts.createProgram({
    rootNames: parsedCommandLine.fileNames,
    options: { ...parsedCommandLine.options, noEmit: true },
  });

  const diagnostics = ts.getPreEmitDiagnostics(program);

  if (diagnostics.length === 0) {
    console.log('✓ TypeScript verification PASSED: 0 errors detected!');
    process.exit(0);
  } else {
    console.error(`❌ Found ${diagnostics.length} TypeScript diagnostic error(s):`);
    for (const diagnostic of diagnostics) {
      if (diagnostic.file) {
        const { line, character } = ts.getLineAndCharacterOfPosition(diagnostic.file, diagnostic.start!);
        const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
        console.error(`${diagnostic.file.fileName} (${line + 1},${character + 1}): ${message}`);
      } else {
        console.error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      }
    }
    process.exit(1);
  }
}

runTypeCheck();
