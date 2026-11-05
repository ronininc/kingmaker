import fs from 'node:fs';
try {fs.readFileSync(process.argv[2]);process.exitCode=2;}
catch(error){process.exitCode=['EPERM','EACCES'].includes(error.code)?0:1;}
