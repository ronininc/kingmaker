import {reviewUploadedFile} from '../sandbox-review.mjs';
const review=reviewUploadedFile(Buffer.from('{"fixture":"parent shutdown"}'),'inert.json');
review.catch(()=>{});
process.stdout.write('READY\n');
setInterval(()=>{},1000);
setTimeout(()=>process.exit(1),15000).unref();
