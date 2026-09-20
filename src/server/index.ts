import express from 'express';
import {fileURLToPath} from 'node:url';
import {inlineCss} from './inline/inline';

type RecordRow = {id:string;name:string;revision:number;content:string;css:string;updatedAt:string};
const rows: RecordRow[] = [
  {id:'alpha',name:'Primary render previews',revision:3,content:'<h1 class="title">Alpha newsletter</h1><p class="lead">render previews: alpha</p><p><a href="https://example.com">Read more</a></p>',css:'.title { color: #1a2b3c; }\n.lead { font-size: 14px; }\na:hover { color: #c00; }\n@media (max-width: 600px) { .lead { font-size: 12px; } }',updatedAt:new Date(0).toISOString()},
  {id:'beta',name:'Secondary render previews',revision:5,content:'<h1 class="title">Beta digest</h1><p class="lead">render previews: beta</p>',css:'.title { color: #334455; }\n.lead { font-size: 15px; }',updatedAt:new Date(1000).toISOString()},
];

export function createApp(){
  const app=express();
  app.use(express.json({limit:'1mb'}));
  app.get('/api/bootstrap',(_req,res)=>res.json({family:"email-rendering",count:rows.length}));
  app.get('/api/templates',(_req,res)=>res.json(rows.map(({content,css,...row})=>row)));
  app.get('/api/templates/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});res.set('ETag',String(row.revision)).json(row)});
  app.put('/api/templates/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});row.content=String(req.body.content??'');if(typeof req.body.css==='string')row.css=req.body.css;row.revision+=1;row.updatedAt=new Date().toISOString();res.json(row)});
  app.post('/api/templates/:id/analyze',async(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?100:20));res.json({id:row.id,revision:row.revision,lines:String(req.body.content??row.content).split(/\r?\n/).length,diagnostics:[]})});
  app.post('/api/templates/:id/preview',async(req,res)=>{
    const row=rows.find(value=>value.id===req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    const controller=new AbortController();
    res.on('close',()=>{if(!res.writableEnded)controller.abort()});
    const media=req.body?.media&&typeof req.body.media==='object'?{type:req.body.media.type,width:req.body.media.width}:undefined;
    try{
      const result=await inlineCss(String(req.body.content??row.content),String(req.body.css??row.css),{media,signal:controller.signal});
      res.json({id:row.id,revision:row.revision,baseRevision:req.body.revision??null,html:result.html,diagnostics:result.diagnostics});
    }catch(err){
      res.status(400).json({error:'preview_failed',message:err instanceof Error?err.message:String(err),baseRevision:req.body.revision??null});
    }
  });
  return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
