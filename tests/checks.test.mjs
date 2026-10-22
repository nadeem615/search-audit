import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCrawl } from '../scripts/lib/checks.mjs';
const page=(url,extra={})=>({url,finalUrl:url,status:200,isHtml:true,headers:{},redirects:[],title:'Distinct useful page',description:'Accurate summary',h1:['Page'],lang:'en',canonical:[url],robotsMeta:[],links:[],images:[],resources:[],jsonLd:[],jsonLdErrors:[],hreflang:[],text:'Unique content',wordCount:100,contentHash:url,...extra});
const crawl=(pages,extra={})=>({target:'https://example.com/',pages,sitemaps:[],robots:{findings:[]},coverage:{},...extra});
test('groups canonical, indexing, broken-link and structured-data evidence into actionable findings',()=>{
 const a=page('https://example.com/',{canonical:['https://example.com/dead'],links:[{url:'https://example.com/dead',text:'Broken'}],jsonLdErrors:[{message:'Invalid JSON'}]});
 const b=page('https://example.com/dead',{status:404,isHtml:false});const c=page('https://example.com/hidden',{robotsMeta:[{name:'robots',content:'noindex'}]});
 const f=analyzeCrawl(crawl([a,b,c],{sitemaps:[{url:'https://example.com/sitemap.xml',status:200,urls:[{url:c.url}]}]}));
 for(const id of ['canonical-unindexable','internal-link-broken','jsonld-invalid','sitemap-noindex'])assert.ok(f.some(x=>x.checkId===id),id);
 for(const item of f){for(const key of ['id','checkId','title','category','severity','kind','confidence','evidence','affectedUrls','recommendation','owner','effort','acceptance','dependencies','priority'])assert.ok(key in item,key);assert.ok(item.acceptance.length);assert.ok(item.evidence.every(e=>e.url&&e.observed&&e.expected&&e.source));}
});
test('keyword similarity is a hypothesis and never triggers an automatic merge',()=>{
 const a=page('https://example.com/a',{title:'Enterprise accounting software comparison',contentHash:'one'}),b=page('https://example.com/b',{title:'Enterprise accounting software comparison',contentHash:'two'});const f=analyzeCrawl(crawl([a,b]));
 const candidate=f.find(x=>x.checkId==='intent-overlap-candidate');assert.equal(candidate.kind,'hypothesis');assert.equal(candidate.confidence,'low');assert.match(candidate.recommendation,/after confirming/);
});
test('intentional training blocks and missing llms.txt create no penalty',()=>{
 const f=analyzeCrawl(crawl([page('https://example.com/')],{robots:{findings:[{userAgent:'GPTBot',purpose:'training',allowed:false},{userAgent:'OAI-SearchBot',purpose:'search',allowed:false,url:'https://example.com/'}]}}));
 assert.equal(f.some(x=>/training.*blocked|llms/i.test(x.checkId)),false);const policy=f.find(x=>x.checkId==='ai-search-policy');assert.equal(policy.severity,'info');assert.equal(policy.kind,'opportunity');
});
test('duplicate content with one consistent canonical is not treated as an unresolved duplicate',()=>{
 const a=page('https://example.com/a',{title:'Original',contentHash:'same'}),b=page('https://example.com/b',{title:'Variant',contentHash:'same',canonical:['https://example.com/a']});assert.equal(analyzeCrawl(crawl([a,b])).some(x=>x.checkId==='content-duplicate'),false);
});
test('empty decorative alt and multiple h1s do not generate invented SEO failures',()=>{
 const p=page('https://example.com/',{h1:['First','Second'],images:[{src:'https://example.com/decorative.svg',alt:''}]});assert.equal(analyzeCrawl(crawl([p])).some(x=>/h1-multiple|image-alt-missing/.test(x.checkId)),false);
});