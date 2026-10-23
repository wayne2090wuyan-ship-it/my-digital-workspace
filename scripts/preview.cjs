'use strict';
const http=require('node:http'), fs=require('node:fs'),path=require('node:path');
const ROOT=path.resolve(__dirname,'..');
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8'};
function createPreview(){return http.createServer((req,res)=>{
  let url;try{url=decodeURIComponent(new URL(req.url,'http://localhost').pathname)}catch{res.writeHead(400).end();return;}
  const allowed=url==='/'||url==='/index.html'||url==='/dashboard.html'||url.startsWith('/assets/')||url.startsWith('/private/');
  if(!allowed||url.split('/').some(x=>x.startsWith('.')&&x!=='')){res.writeHead(404).end();return;}
  const file=path.resolve(ROOT,'.'+url+(url.endsWith('/')?'index.html':''));
  if(!file.startsWith(ROOT+path.sep)){res.writeHead(403).end();return;}
  fs.readFile(file,(err,data)=>{if(err){res.writeHead(404).end();return;}res.writeHead(200,{'Content-Type':TYPES[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:data);});
});}
module.exports={createPreview};
if(require.main===module){const port=Number(process.env.MDW_PREVIEW_PORT||4173);createPreview().listen(port,'127.0.0.1',()=>console.log(`Preview: http://127.0.0.1:${port}/private/?mode=demo`));}
