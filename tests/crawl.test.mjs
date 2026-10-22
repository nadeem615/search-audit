import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crawlSite, parsePage, normalizeUrl, isPrivateAddress } from '../scripts/lib/crawl.mjs';
async function fixture(t){
 let base;const hits=[];
 const server=createServer((req,res)=>{hits.push(req.url);const path=req.url.split('?')[0];
 if(path==='/robots.txt'){res.setHeader('content-type','text/plain');return res.end(`User-agent: *\nDisallow: /docs/private\nUser-agent: GPTBot\nDisallow: /\nSitemap: ${base}/map-index.xml\n`);}
 if(path==='/map-index.xml'){res.setHeader('content-type','application/xml');return res.end(`<sitemapindex><sitemap><loc>${base}/map.xml</loc></sitemap></sitemapindex>`);}
 if(path==='/map.xml'){res.setHeader('content-type','application/xml');return res.end(`<urlset><url><loc>${base}/docs/noindex</loc></url><url><loc>${base}/docs/private</loc></url></urlset>`);}
 if(path==='/sitemap.xml'){res.statusCode=404;return res.end('not found');}
 if(path==='/docs/redirect'){res.writeHead(301,{location:'/docs/hop'});return res.end();}
 if(path==='/docs/hop'){res.writeHead(302,{location:'/docs/a?variant=1'});return res.end();}
 if(path==='/docs/loop'){res.writeHead(302,{location:'/docs/loop'});return res.end();}
 res.setHeader('content-type','text/html');
 if(path==='/docs/')return res.end(`<html lang="en"><head><title>Home | Fixture Brand</title><meta property="og:site_name" content="Fixture Brand"><meta name="theme-color" content="#123456"></head><body><h1>Welcome</h1><a href="/docs/redirect">Go</a><a href="/docs/a?variant=2">Variant</a><a href="/docs/loop">Loop</a><a href="/outside">Outside scope</a></body></html>`);
 if(path==='/docs/noindex')res.setHeader('x-robots-tag','noindex');
 return res.end(`<html lang="en"><head><title>${path}</title><link rel="canonical" href="${base}${req.url}"></head><body><main><h1>${path}</h1><p>Useful page text.</p></main></body></html>`);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;t.after(()=>new Promise(resolve=>server.close(resolve)));return{base,hits};
}
test('crawler honours scope and robots, expands sitemap indexes and preserves query variants',async t=>{
 const{base,hits}=await fixture(t);const result=await crawlSite(`${base}/docs/`,{allowPrivate:true,delayMs:0,maxPages:20});
 assert.equal(result.brand.name,'Fixture Brand');assert.equal(result.brand.primaryColor,'#123456');
 assert.ok(result.pages.some(p=>p.url.endsWith('?variant=2')));assert.ok(result.pages.some(p=>p.url.endsWith('/docs/noindex')));
 assert.equal(hits.includes('/docs/private'),false);assert.equal(hits.includes('/outside'),false);
 assert.ok(result.coverage.exclusions.some(p=>p.reason==='robots-disallow'));
 const redirect=result.pages.find(p=>p.url.endsWith('/docs/redirect'));assert.equal(redirect.status,200);assert.equal(redirect.redirects.length,2);assert.ok(redirect.finalUrl.endsWith('?variant=1'));
 const loop=result.pages.find(p=>p.url.endsWith('/docs/loop'));assert.equal(loop.status,0);assert.match(loop.error,/loop/i);
 assert.equal(result.robots.findings.find(b=>b.userAgent==='GPTBot').allowed,false);
 assert.equal(result.sitemaps.find(s=>s.type==='urlset').urlCount,2);
});
test('page budget persists and resumes the remaining queue',async t=>{
 const{base}=await fixture(t),dir=await mkdtemp(join(tmpdir(),'search-audit-state-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const stateFile=join(dir,'state.json');const first=await crawlSite(`${base}/docs/`,{allowPrivate:true,delayMs:0,maxPages:1,stateFile});assert.equal(first.pages.length,1);assert.equal(first.coverage.truncated,true);
 const resumed=await crawlSite(`${base}/docs/`,{allowPrivate:true,delayMs:0,maxPages:20,stateFile,resume:true});assert.ok(resumed.pages.length>first.pages.length);assert.equal(resumed.pages.filter(p=>p.url===`${base}/docs/`).length,1);
});
test('private networks require explicit opt in and URL normalization rejects credentials',async()=>{
 await assert.rejects(crawlSite('http://127.0.0.1:1/'),/Private/);assert.equal(normalizeUrl('https://user:secret@example.com/'),null);
 assert.equal(normalizeUrl('/p?a=1#part','https://example.com/'),'https://example.com/p?a=1');
 for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','::1','::ffff:7f00:1'])assert.equal(isPrivateAddress(address),true,address);assert.equal(isPrivateAddress('8.8.8.8'),false);
});
test('parser distinguishes missing alt from decorative empty alt and captures malformed JSON-LD',()=>{
 const p=parsePage('<title>Example</title><h1>Main</h1><img src="/a"><img src="/b" alt=""><script type="application/ld+json">{oops}</script>','https://example.com/');assert.equal(p.images[0].alt,null);assert.equal(p.images[1].alt,'');assert.equal(p.jsonLdErrors.length,1);assert.equal(p.h1[0],'Main');
});
test('missing base href does not invent undefined routes for fragments or missing attributes', () => {
 const page = parsePage('<a href="#benefits">Benefits</a><a href="apply">Apply</a><img alt="Logo">', 'https://example.com/volunteer/');
 assert.equal(page.links[0].url, 'https://example.com/volunteer/');
 assert.equal(page.links[1].url, 'https://example.com/volunteer/apply');
 assert.equal(page.images[0].src, null);
 assert.equal(normalizeUrl(undefined, 'https://example.com/'), null);
});
