#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAudit } from './audit.mjs';

export async function startDemoSite({ brand = 'Northstar Coffee' } = {}) {
  let origin;
  const requests = [];
  const paragraph = 'Our coffee is roasted in small batches with clear origin information and practical brewing guidance. Choose whole beans for espresso or filter brewing, compare roast profiles and order freshly roasted coffee. Each product explains the producer, processing method and tasting notes so customers can select coffee that suits their equipment and preferences.';
  const page = (title, body, head = '') => '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#704b32"><meta property="og:site_name" content="Northstar Coffee"><title>' + title + '</title><style>body{font-family:Arial,sans-serif;background:#fbf7f0;color:#2a211a;max-width:850px;margin:40px auto;line-height:1.6;padding:20px}a{color:#704b32}nav{display:flex;gap:20px}h1{font-size:42px}img{max-width:100%}</style>' + head + '</head><body><header><strong>Northstar Coffee</strong><nav><a href="/">Home</a><a href="/coffee/beans">Coffee</a><a href="/guides/beans">Brewing guide</a></nav></header><main>' + body + '</main></body></html>';
  const server = http.createServer((req, res) => {
    const route = new URL(req.url, origin).pathname;
    requests.push(route);
    if (route === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nDisallow: /private\n\nUser-agent: OAI-SearchBot\nDisallow: /guides\n\nUser-agent: GPTBot\nDisallow: /\n\nSitemap: ' + origin + '/sitemap.xml\n'); return;
    }
    if (route === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
        ['/', '/coffee/beans', '/coffee/special', '/guides/beans', '/bad-canonical', '/orphan', '/noindex', '/redirect'].map(p => '<url><loc>' + origin + p + '</loc></url>').join('') + '</urlset>'); return;
    }
    if (route === '/redirect' || route === '/redirect-again') {
      res.writeHead(301, { location: route === '/redirect' ? '/redirect-again' : '/coffee/beans' }); res.end(); return;
    }
    if (route === '/private') { res.writeHead(200); res.end('Private content must not be fetched.'); return; }
    const pages = {
      '/': page('Northstar Coffee | Freshly roasted coffee', '<h1>Better coffee starts here</h1><p>' + paragraph + '</p><a href="/bad-canonical">Limited edition</a> <a href="/missing">Old catalogue</a> <a href="/private">Private</a> <a href="/redirect">Previous shop</a><div id="extra"></div><script>setTimeout(()=>{document.getElementById("extra").innerHTML=\'<a href="/render-only">Seasonal coffee</a>\'},100)</script>', '<meta name="description" content="Freshly roasted coffee and practical brewing advice from Northstar Coffee."><link rel="canonical" href="' + origin + '/">'),
      '/coffee/beans': page('Buy coffee beans | Northstar Coffee', '<h1>Buy coffee beans</h1><p>' + paragraph + '</p><img src="/missing-image.png"><a href="/coffee/special">Special selection</a>', '<meta name="description" content="Choose freshly roasted coffee beans."><link rel="canonical" href="' + origin + '/coffee/beans">'),
      '/coffee/special': page('Buy coffee beans | Northstar Coffee', '<h1>Buy coffee beans</h1><p>' + paragraph + '</p>', '<meta name="description" content="Choose freshly roasted coffee beans."><link rel="canonical" href="' + origin + '/coffee/special">'),
      '/guides/beans': page('How to choose coffee beans | Northstar Coffee', '<h1>How to choose coffee beans</h1><p>Start with the equipment you use. Espresso generally needs a fine grind and a balanced recipe. Filter brewing uses a coarser grind and highlights origin character. Compare roast date, origin, processing and recommended brewing methods before choosing.</p><h2>Espresso or filter?</h2><p>Choose the roast that matches your brewing method and taste, then adjust one variable at a time.</p>'),
      '/bad-canonical': page('', '<p>This product template has incomplete metadata and a canonical pointing to a missing destination.</p>', '<link rel="canonical" href="' + origin + '/missing"><script type="application/ld+json">{"@context":</script>'),
      '/orphan': page('Wholesale coffee | Northstar Coffee', '<h1>Wholesale coffee for cafes</h1><p>Our wholesale team helps cafes choose coffee, train baristas and plan reliable deliveries. Contact the team for a sample and a discussion of your requirements.</p>'),
      '/noindex': page('Account | Northstar Coffee', '<h1>Your account</h1>', '<meta name="robots" content="noindex,follow">'),
      '/render-only': page('Seasonal coffee | Northstar Coffee', '<h1>Seasonal coffee</h1><p>Current seasonal offerings and tasting notes.</p>')
    };
    res.writeHead(pages[route] ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end((pages[route] ?? page('Not found | Northstar Coffee', '<h1>Page not found</h1><a href="/">Home</a>')).replaceAll('Northstar Coffee', brand));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  return { server, origin, requests, close: () => new Promise(resolve => server.close(resolve)) };
}
export async function demo({ output = path.resolve('../demo-report'), performance = true, pdf = true, devices = 'mobile' } = {}) {
  const site = await startDemoSite();
  try {
    return await runAudit(site.origin + '/', { output, 'data-dir': path.join(output, '.state'), 'allow-private': true,
      'max-pages': '30', 'delay-ms': '0', render: '2', devices, lighthouse: performance ? '1' : '0', pdf });
  } finally { await site.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  demo({ performance: !process.argv.includes('--no-performance'), pdf: !process.argv.includes('--no-pdf'), devices: process.argv.find(arg => arg.startsWith('--devices='))?.slice(10) ?? 'mobile' })
    .catch(error => { console.error(error); process.exitCode = 1; });
}
