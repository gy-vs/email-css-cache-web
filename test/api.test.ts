import {describe,expect,it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
describe('service',()=>{it('loads and conditionally updates a record',async()=>{const app=createApp();const before=await request(app).get('/api/templates/alpha').expect(200);await request(app).put('/api/templates/alpha').send({content:'updated',revision:before.body.revision}).expect(200);await request(app).put('/api/templates/alpha').send({content:'stale',revision:before.body.revision}).expect(409)})});

describe('preview endpoint',()=>{
  it('inlines css and echoes the template revision',async()=>{
    const app=createApp();
    const row=(await request(app).get('/api/templates/alpha').expect(200)).body;
    const response=await request(app).post('/api/templates/alpha/preview').send({revision:row.revision,html:'<p class="promo">hi</p>',css:'.promo{color:red}'}).expect(200);
    expect(response.body.id).toBe('alpha');
    expect(response.body.revision).toBe(row.revision);
    expect(response.body.html).toBe('<p class="promo" style="color: red">hi</p>');
    expect(response.body.diagnostics).toEqual([]);
  });

  it('rejects a stale revision with 409',async()=>{
    const app=createApp();
    const response=await request(app).post('/api/templates/alpha/preview').send({revision:999,html:'<p>x</p>',css:''}).expect(409);
    expect(response.body.error).toBe('revision_conflict');
    expect(response.body.current.id).toBe('alpha');
  });

  it('renders the same css independently per template dom',async()=>{
    const app=createApp();
    const css='.promo{color:red}';
    const alpha=(await request(app).get('/api/templates/alpha').expect(200)).body;
    const beta=(await request(app).get('/api/templates/beta').expect(200)).body;
    const first=await request(app).post('/api/templates/alpha/preview').send({revision:alpha.revision,html:'<p class="promo">a</p>',css}).expect(200);
    const second=await request(app).post('/api/templates/beta/preview').send({revision:beta.revision,html:'<p class="plain">b</p>',css}).expect(200);
    expect(first.body.html).toBe('<p class="promo" style="color: red">a</p>');
    expect(second.body.html).toBe('<p class="plain">b</p>');
  });

  it('survives a client abort and keeps serving previews',async()=>{
    const app=createApp();
    const row=(await request(app).get('/api/templates/alpha').expect(200)).body;
    const bigHtml='<div>'+Array.from({length:5000},(_,i)=>`<p class="x">${i}</p>`).join('')+'</div>';
    const pending=request(app).post('/api/templates/alpha/preview').send({revision:row.revision,html:bigHtml,css:'.x{color:red}'});
    pending.abort();
    await pending.catch(()=>{/* aborted requests reject on the client side */});
    const after=await request(app).post('/api/templates/alpha/preview').send({revision:row.revision,html:'<p class="x">ok</p>',css:'.x{color:red}'}).expect(200);
    expect(after.body.html).toBe('<p class="x" style="color: red">ok</p>');
  });
});
