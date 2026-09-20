import {useEffect,useRef,useState} from 'react';
import {Eye,FlaskConical,Play,Save} from 'lucide-react';
import {PreviewOwner,PreviewTracker} from './previewOwnership';
type Summary={id:string;name:string;revision:number;updatedAt:string};
type Row=Summary&{content:string;css:string};
type Diagnostic={code:string;message:string;detail?:string};
type Preview={html:string;diagnostics:Diagnostic[]};
export default function App(){
  const [items,setItems]=useState<Summary[]>([]);const [selected,setSelected]=useState('alpha');const [row,setRow]=useState<Row|null>(null);const [draft,setDraft]=useState('');const [cssDraft,setCssDraft]=useState('');const [analysis,setAnalysis]=useState<unknown>(null);const [preview,setPreview]=useState<Preview|null>(null);const [previewIssue,setPreviewIssue]=useState<string|null>(null);const [status,setStatus]=useState('Ready');
  const tracker=useRef(new PreviewTracker());
  useEffect(()=>{fetch('/api/templates').then(r=>r.json()).then(setItems)},[]);
  useEffect(()=>{
    tracker.current.setCurrent(null);setPreview(null);setPreviewIssue(null);setAnalysis(null);setStatus('Loading');
    let cancelled=false;
    fetch('/api/templates/'+selected).then(r=>r.json()).then((value:Row)=>{if(cancelled)return;setRow(value);setDraft(value.content);setCssDraft(value.css);tracker.current.setCurrent({id:value.id,revision:value.revision});setStatus('Loaded')});
    return ()=>{cancelled=true};
  },[selected]);
  async function save(){if(!row)return;setStatus('Saving');const response=await fetch('/api/templates/'+row.id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft,css:cssDraft,revision:row.revision})});const value=await response.json();if(!response.ok){setStatus('Revision conflict');return}setRow(value);tracker.current.setCurrent({id:value.id,revision:value.revision});setStatus('Saved')}
  async function analyze(){if(!row)return;setStatus('Analyzing');const response=await fetch('/api/templates/'+row.id+'/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft})});setAnalysis(await response.json());setStatus('Ready')}
  async function runPreview(){
    if(!row)return;
    const owner:PreviewOwner={id:row.id,revision:row.revision};
    setStatus('Previewing');
    try{
      const response=await fetch('/api/templates/'+owner.id+'/preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft,css:cssDraft,revision:owner.revision})});
      const value=await response.json();
      if(!tracker.current.isCurrent(owner))return; // a newer revision/template owns the pane
      if(!response.ok){setPreviewIssue(value.message??'Preview failed');setStatus('Ready');return}
      setPreview({html:value.html,diagnostics:value.diagnostics??[]});setPreviewIssue(null);setStatus('Ready');
    }catch{
      if(!tracker.current.isCurrent(owner))return; // stale failure must not clear the new preview
      setPreviewIssue('Preview request failed');setStatus('Ready');
    }
  }
  return <main className="shell"><header className="topbar"><FlaskConical size={20}/><strong>Email Rendering Lab</strong><small>Local workspace</small></header><section className="workspace"><aside className="pane"><h2>Items</h2><div className="list">{items.map(item=><button className={item.id===selected?'active':''} onClick={()=>setSelected(item.id)} key={item.id}>{item.name}<br/><small>Revision {item.revision}</small></button>)}</div></aside><section className="pane"><div className="toolbar"><button className="primary" onClick={save}><Save size={15}/>Save</button><button onClick={analyze}><Play size={15}/>Analyze</button><button onClick={runPreview}><Eye size={15}/>Preview</button><span>{status}</span></div><textarea aria-label="Content" value={draft} onChange={event=>setDraft(event.target.value)}/><textarea aria-label="CSS" value={cssDraft} onChange={event=>setCssDraft(event.target.value)}/></section><aside className="pane"><h2>Inspection</h2><span className="pill">{selected}</span>{previewIssue?<p className="issue">{previewIssue}</p>:null}{preview?<><iframe title="Preview" sandbox="" srcDoc={preview.html}/>{preview.diagnostics.length?<ul className="diagnostics">{preview.diagnostics.map((d,i)=><li key={i}><code>{d.code}</code> {d.message}</li>)}</ul>:null}</>:<pre>{JSON.stringify(analysis??row,null,2)}</pre>}</aside></section></main>;
}
