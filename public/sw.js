const CACHE='telahub-v16';
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',(event)=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',(event)=>{if(event.request.method!=='GET'||new URL(event.request.url).pathname.startsWith('/api/'))return;event.respondWith(fetch(event.request).then(response=>{const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy));return response;}).catch(()=>caches.match(event.request)));});
