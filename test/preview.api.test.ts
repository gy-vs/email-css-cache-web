import {describe,expect,it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';

describe('preview endpoint',()=>{
  it('inlines css and echoes the base revision',async()=>{
    const app=createApp();
    const res=await request(app).post('/api/templates/alpha/preview').send({content:'<p class="lead">hi</p>',css:'.lead { color: red; }',revision:3}).expect(200);
    expect(res.body.id).toBe('alpha');
    expect(res.body.baseRevision).toBe(3);
    expect(res.body.html).toBe('<p class="lead" style="color: red">hi</p>');
  });
  it('404s for unknown templates',async()=>{
    const app=createApp();
    await request(app).post('/api/templates/nope/preview').send({}).expect(404);
  });
  it('a second preview does not pick up styles from the first (the reported bug)',async()=>{
    const app=createApp();
    const css='.lead { color: red; }';
    const first=await request(app).post('/api/templates/alpha/preview').send({content:'<p class="lead">A</p>',css}).expect(200);
    const second=await request(app).post('/api/templates/beta/preview').send({content:'<div>B</div>',css}).expect(200);
    expect(first.body.html).toContain('color: red');
    expect(second.body.html).not.toContain('color: red');
    const reverse=await request(app).post('/api/templates/alpha/preview').send({content:'<p class="lead">A2</p>',css}).expect(200);
    expect(reverse.body.html).toContain('color: red');
  });
  it('handles concurrent previews on different templates in isolation',async()=>{
    const app=createApp();
    const css='.lead { color: red; }';
    const [a,b]=await Promise.all([
      request(app).post('/api/templates/alpha/preview').send({content:'<p class="lead">A</p>',css}),
      request(app).post('/api/templates/beta/preview').send({content:'<div>B</div>',css}),
    ]);
    expect(a.body.html).toContain('color: red');
    expect(b.body.html).not.toContain('color: red');
  });
  it('applies media rules only when the context matches',async()=>{
    const app=createApp();
    const css='p { color: black; } @media (max-width: 600px) { p { color: blue; } }';
    const narrow=await request(app).post('/api/templates/beta/preview').send({content:'<p>x</p>',css,media:{width:480}}).expect(200);
    expect(narrow.body.html).toContain('color: blue');
    const wide=await request(app).post('/api/templates/beta/preview').send({content:'<p>x</p>',css,media:{width:1024}}).expect(200);
    expect(wide.body.html).toContain('color: black');
  });
});
