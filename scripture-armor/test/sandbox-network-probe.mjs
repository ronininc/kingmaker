import net from 'node:net';
const socket=net.createConnection({host:'127.0.0.1',port:9});
socket.on('connect',()=>{socket.destroy();process.exitCode=2;});
socket.on('error',error=>{process.exitCode=['EPERM','EACCES'].includes(error.code)?0:1;});
