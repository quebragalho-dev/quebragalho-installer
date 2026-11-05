// Executado pelo teste de sinais: roda execute() num processo à parte, porque re-emitir o sinal do filho mata quem chama.
import { execute } from '../lib/exec.mjs';

const [file, ...args] = process.argv.slice(2);
await execute({ platform: process.platform, err: text => console.error(text) }, 'falso', file, args, { ...process.env }, undefined);
console.log(`exitCode=${process.exitCode ?? 0}`);
