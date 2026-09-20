import {useEffect,useRef,useState} from 'react';
import {Eye,FlaskConical,Play,Save} from 'lucide-react';
import {PreviewCoordinator} from './previewCoordinator';
type Summary={id:string;name:string;revision:number;updatedAt:string};
type Row=Summary&{content:string};
type Diagnostic={code:string;message:string;context?:string};
type Preview={id:string;revision:number;html:string;diagnostics:Diagnostic[]};
const DEFAULT_CSS='.promo { color: #c2410c; font-weight: bold; }\np { line-height: 1.5; }';
export default function App(){
  const [items,setItems]=useState<Summary[]>([]);
  const [selected,setSelected]=useState('alpha');
  const [row,setRow]=useState<Row|null>(null);
  const [draft,setDraft]=useState('');
  const [css,setCss]=useState(DEFAULT_CSS);
  const [analysis,setAnalysis]=useState<unknown>(null);
  const [preview,setPreview]=useState<Preview|null>(null);
  const [previewError,setPreviewError]=useState<string|null>(null);
  const [status,setStatus]=useState('Ready');
  const coordinator=useRef(new PreviewCoordinator());
  const abortRef=useRef<AbortController|null>(null);
  const rowRef=useRef<Row|null>(null);
  rowRef.current=row;
  const cssByTemplate=useRef<Record<string,string>>({});
  useEffect(()=>{fetch('/api/templates').then(r=>r.json()).then(setItems)},[]);
  useEffect(()=>{
    setStatus('Loading');
    // Switching templates invalidates every in-flight preview request.
    coordinator.current.invalidate();
    abortRef.current?.abort();
    setPreview(null);
    setPreviewError(null);
    setCss(cssByTemplate.current[selected]??DEFAULT_CSS);
    fetch('/api/templates/'+selected).then(r=>r.json()).then((value:Row)=>{setRow(value);setDraft(value.content);setStatus('Loaded')});
  },[selected]);
  async function save(){if(!row)return;setStatus('Saving');const response=await fetch('/api/templates/'+row.id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft,revision:row.revision})});const value=await response.json();if(!response.ok){setStatus('Revision conflict');return}setRow(value);setStatus('Saved')}
  async function analyze(){if(!row)return;setStatus('Analyzing');const response=await fetch('/api/templates/'+row.id+'/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft})});setAnalysis(await response.json());setStatus('Ready')}
  async function runPreview(){
    const current=rowRef.current;
    if(!current)return;
    cssByTemplate.current[current.id]=css;
    abortRef.current?.abort();
    const ac=new AbortController();
    abortRef.current=ac;
    // Attribute this request to the template id + revision visible right now.
    const token=coordinator.current.begin(current.id,current.revision);
    const guard=()=>{const latest=rowRef.current;return coordinator.current.isCurrent(token,latest?{id:latest.id,revision:latest.revision}:null)};
    setStatus('Rendering');
    try{
      const response=await fetch('/api/templates/'+current.id+'/preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({revision:current.revision,html:draft,css}),signal:ac.signal});
      const value=await response.json();
      if(!guard())return;
      if(!response.ok){setPreviewError(value.error??'render_failed');setStatus('Preview failed');return}
      setPreview(value);
      setPreviewError(null);
      setStatus('Rendered');
    }catch{
      // A stale request must never clear or error out the newer preview.
      if(!guard())return;
      if(ac.signal.aborted)return;
      setPreviewError('network_error');
      setStatus('Preview failed');
    }
  }
  return <main className="shell"><header className="topbar"><FlaskConical size={20}/><strong>Email Rendering Lab</strong><small>Local workspace</small></header><section className="workspace"><aside className="pane"><h2>Items</h2><div className="list">{items.map(item=><button className={item.id===selected?'active':''} onClick={()=>setSelected(item.id)} key={item.id}>{item.name}<br/><small>Revision {item.revision}</small></button>)}</div></aside><section className="pane"><div className="toolbar"><button className="primary" onClick={save}><Save size={15}/>Save</button><button onClick={analyze}><Play size={15}/>Analyze</button><button onClick={runPreview}><Eye size={15}/>Preview</button><span>{status}</span></div><textarea aria-label="Content" value={draft} onChange={event=>setDraft(event.target.value)}/><textarea aria-label="CSS" value={css} onChange={event=>setCss(event.target.value)}/></section><aside className="pane"><h2>Preview</h2>{previewError&&<span className="pill error">{previewError}</span>}{preview?<><iframe title="Preview" sandbox="" srcDoc={preview.html}/>{preview.diagnostics.length>0&&<ul className="diagnostics">{preview.diagnostics.map((diagnostic,index)=><li key={index}><code>{diagnostic.code}</code> {diagnostic.message}{diagnostic.context?` — ${diagnostic.context}`:''}</li>)}</ul>}</>:<p>No preview yet.</p>}<h2>Inspection</h2><span className="pill">{selected}</span><pre>{JSON.stringify(analysis??row,null,2)}</pre></aside></section></main>;
}
