import { startWorker } from './worker';

const directory = process.argv[2];
if (!directory) throw new Error('缺少 TermDock 配置目录');
startWorker(directory);
