import express from 'express';
import {fileURLToPath} from 'node:url';
import {renderPreview, RenderCancelled, sharedStylesheetCache} from './render';

type RecordRow = {id:string;name:string;revision:number;content:string;updatedAt:string};
const rows: RecordRow[] = [
  {id:'alpha',name:'Primary render previews',revision:3,content:'<html><head><style>.promo{color:#c2410c;font-weight:bold}</style></head><body><p class="promo">render previews: alpha</p><p>state: active</p></body></html>',updatedAt:new Date(0).toISOString()},
  {id:'beta',name:'Secondary render previews',revision:5,content:'<html><head><style>.promo{color:#1d4ed8}</style></head><body><p class="promo">render previews: beta</p><p>state: review</p></body></html>',updatedAt:new Date(1000).toISOString()},
];

export function createApp(){
  const app=express();
  app.use(express.json({limit:'1mb'}));
  app.get('/api/bootstrap',(_req,res)=>res.json({family:"email-rendering",count:rows.length}));
  app.get('/api/templates',(_req,res)=>res.json(rows.map(({content,...row})=>row)));
  app.get('/api/templates/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});res.set('ETag',String(row.revision)).json(row)});
  app.put('/api/templates/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});row.content=String(req.body.content??'');row.revision+=1;row.updatedAt=new Date().toISOString();res.json(row)});
  app.post('/api/templates/:id/analyze',async(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?100:20));res.json({id:row.id,revision:row.revision,lines:String(req.body.content??row.content).split(/\r?\n/).length,diagnostics:[]})});
  app.post('/api/templates/:id/preview',async(req,res)=>{
    const row=rows.find(value=>value.id===req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    const body=req.body??{};
    if(body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:{id:row.id,revision:row.revision}});
    // If the client goes away (template switched, request superseded), cancel
    // the render so it stops consuming work; per-render state is discarded.
    const ac=new AbortController();
    res.on('close',()=>{if(!res.writableEnded)ac.abort();});
    try{
      const result=await renderPreview(String(body.html??row.content),String(body.css??''),{
        signal:ac.signal,
        cache:sharedStylesheetCache,
        media:body.options?.media,
      });
      res.json({id:row.id,revision:row.revision,html:result.html,diagnostics:result.diagnostics});
    }catch(err){
      if(err instanceof RenderCancelled){if(!res.writableEnded)res.status(499).json({error:'cancelled'});return}
      res.status(422).json({error:'render_failed',message:err instanceof Error?err.message:String(err)});
    }
  });
  return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
