import { readFileSync, writeFileSync } from 'node:fs';
import { analyze, type History } from '@tells/core';
import { carefulUser, exchangeUser } from '../../../apps/web/src/samples';

const files = ['demo/illustrative-careful.json', 'demo/illustrative-exchange.json', 'apps/web/public/samples/testnet.json'];
const reports = Object.fromEntries(files.map(file => [file, analyze(JSON.parse(readFileSync(file, 'utf8')) as History)]));
reports['web/carefulUser'] = analyze(carefulUser);
reports['web/exchangeUser'] = analyze(exchangeUser);
const json = JSON.stringify(reports, null, 2) + '\n';
if (process.argv[2]) writeFileSync(process.argv[2], json);
else process.stdout.write(json);
