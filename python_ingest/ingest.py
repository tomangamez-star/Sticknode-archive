#!/usr/bin/env python3
import argparse, hashlib, html, os, re, time
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse, unquote
from bs4 import BeautifulSoup
# from curl_cffi import requests   # <--- REMOVE THIS LINE
import psycopg
from psycopg.rows import dict_row

BASE=os.getenv('STICKNODES_BASE_URL','https://sticknodes.com').rstrip('/')
LIST=os.getenv('STICKNODES_LIST_URL','https://sticknodes.com/stickfigures/').strip()
TOKEN=os.environ['TELEGRAM_TOKEN'].strip(); CHAT=os.environ['ARCHIVE_CHAT_ID'].strip(); DB=os.environ['DATABASE_URL'].strip()
DELAY=max(.1,float(os.getenv('SCRAPER_SITE_DELAY_MS','350'))/1000); UPLOAD_DELAY=max(.25,float(os.getenv('SCRAPER_UPLOAD_DELAY_MS','1100'))/1000)
MAX_MB=min(49,max(1,int(os.getenv('SCRAPER_MAX_FILE_MB','45')))); MAX_BYTES=MAX_MB*1024*1024
FETCH_DETAILS=os.getenv('SCRAPER_FETCH_DETAILS','true').lower() in ('1','true','yes','on')

# Browser setup for GitHub Actions / CI
import undetected_chromedriver as uc
import sys

class CustomSession:
    def __init__(self):
        self.options = uc.ChromeOptions()
        self.options.add_argument("--headless=new")
        self.options.add_argument("--no-sandbox")
        self.options.add_argument("--disable-dev-shm-usage")
        self.options.add_argument("--window-size=1280,720")

        try:
            sys.stdout.write("[init] Starting Chrome...\n")
            self._driver = uc.Chrome(options=self.options, version_main=151)
            self._driver.set_page_load_timeout(45)
            time.sleep(0.5)
            return
        except Exception as e:
            print(f"[Error] Browser init failed: {e}")
            raise

    def close(self):
        if hasattr(self, "_driver"):
            self._driver.quit()

s = CustomSession()

UA=os.getenv('STICKNODES_USER_AGENT','Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/139.0.0.0 Safari/537.36')
CATS=['Backgrounds','Effects','Miscellaneous','Objects','Packs','People','Weapons','Vehicles']

def clean(x): return re.sub(r'\s+',' ',str(x or '')).strip()
def fname(url): return unquote(urlparse(url).path.rsplit('/',1)[-1])
def ftype(name,title=''):
    x=(name+' '+title).lower()
    if name.lower().endswith('.zip'): return 'pack'
    if name.lower().endswith('.nodemc') or 'movieclip' in x: return 'movieclip'
    return 'node'
def norm(x): return clean(x).lower()
def tags(title,cat,typ): return list(dict.fromkeys(re.findall(r'[a-z0-9]+',norm(title))+[cat,typ]))
def page_url(n): return LIST + ('&' if '?' in LIST else '?') + f'wpfb_list_page={max(1,n)}'

def get(url, timeout=45):
    last=None
    for i in range(4):
        try:
            # Execute network enable to handle redirects properly via CDP if needed
            s._driver.execute_cdp_cmd("Network.enable", {}) 
            
            r = s._driver.get(url) # Navigate using Selenium; timeout is set via set_page_load_timeout()

print("[debug] PAGE TITLE:", s._driver.title)
print("[debug] CURRENT URL:", s._driver.current_url)
print("[debug] HTML LENGTH:", len(s._driver.page_source))
print("[debug] PAGE PREVIEW:", s._driver.page_source[:500].replace("\n", " "))

time.sleep(max(0.1, float(os.getenv('SCRAPER_SITE_DELAY_MS','350'))/1000))
            
            status_code = s._driver.current_url  # Check redirect loop or final URL logic here if complex
            text_content = s._driver.page_source
                
            # Simulate a simple response object for compatibility with existing code (mostly text-based parsing)
            class FakeResponse:
                def __init__(self, text): self.text = self.html_text = text 
                @property 
                def content(self): return self.text.encode()
                
                def raise_for_status(self): 
                    try: int(s._driver.execute_cdp_cmd("Network.getResponseBody", {"requestId": r.id}).get("body", "")) 
                    except: pass
                    
                status_code = 200
                headers = {}
            
            if '429' in str(text_content) or s._driver.current_url.startswith('http://'): # Fallback check for retry-after logic if parsed from source
                 time.sleep(max(2,int(re.search(r'try-after',text_content,flags=re.I).group(1))) if re.search(r'retry-after', text_content,re.I) else 3); continue
            
            return FakeResponse(text_content)

        except Exception as e:
            last=e
            # Basic error handling similar to curl_cffi but adapted for browser state
            if i < 3 and 'NetworkError' not in str(e): 
                time.sleep(i+1)
    raise last or RuntimeError(f"Browser session failed after retries")
def category_from(url):
    p=urlparse(url).path.lower()
    for c in CATS:
        if f'/download/{c.lower()}/' in p: return c.lower()
    return 'miscellaneous'

def parse_listing(text,url):
    soup=BeautifulSoup(text,'html.parser'); out=[]; seen=set()
    for a in soup.select('a[href*="/download/"]'):
        href=urljoin(url,a.get('href','')); name=fname(href)
        if not re.search(r'\.(nodes|nodemc|stk|zip)$',name,re.I) or href in seen: continue
        node=a
        for _ in range(8):
            txt=clean(node.get_text(' ',strip=True))
            if re.search(r'Hits:\s*[\d,]+',txt,re.I) and node.select_one('a[href*="/sticks/"]'): break
            if not node.parent: break
            node=node.parent
        text2=clean(node.get_text(' ',strip=True)); title=clean(a.get_text()) or re.sub(r'[-_]+',' ',re.sub(r'\.(nodes|nodemc|stk|zip)$','',name,flags=re.I))
        da=node.select_one('a[href*="/sticks/"]'); detail=urljoin(url,da.get('href','')) if da else ''
        cm=re.search(r'\((Backgrounds|Effects|Miscellaneous|Objects|People|Weapons|Vehicles|Packs)(?:\s+(\d+))?\)',text2,re.I)
        cat=cm.group(1).lower() if cm else category_from(href); typ=ftype(name,title)
        hm=re.search(r'Hits:\s*([\d,]+)',text2,re.I); dm=re.search(r'(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}',text2,re.I)
        out.append(dict(source_url=href,download_url=href,detail_url=detail,source_page=url,title=title,original_filename=name,file_type=typ,category='packs' if typ=='pack' else cat,categories=['packs' if typ=='pack' else cat],tags=tags(title,cat,typ),creator='',creator_handle='',description='',source_date=dm.group(0) if dm else '',source_hits=int(hm.group(1).replace(',','')) if hm else 0,pack_count=int(cm.group(2)) if cm and cm.group(2) else 0,declared_size_bytes=0))
        seen.add(href)
    return out

def hydrate(item):
    if not FETCH_DETAILS or not item['detail_url']: return item
    time.sleep(DELAY); soup=BeautifulSoup(get(item['detail_url']).text,'html.parser'); body=clean(soup.get_text(' ',strip=True)); h=soup.find('h1'); heading=clean(h.get_text()) if h else item['title']
    fm=re.search(r'File:\s*([^\s][^()]+?)\s*\(([^)]+)\)',body,re.I); dm=re.search(r'Date:\s*((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4})',body,re.I)
    name=clean(fm.group(1)) if fm else item['original_filename']; typ=ftype(name,heading); cat='packs' if typ=='pack' else item['category']
    hs=[clean(a.get_text())[1:].lower() for a in soup.find_all('a') if re.match(r'^#[\w-]+$',clean(a.get_text()))]
    item.update(title=heading,original_filename=name,file_type=typ,category=cat,tags=list(dict.fromkeys(item['tags']+hs+tags(heading,cat,typ))),source_date=dm.group(1) if dm else item['source_date'])
    return item

def conn(): return psycopg.connect(DB, sslmode='require' if not re.search(r'localhost|127\.0\.0\.1',DB) else 'prefer', row_factory=dict_row)
def q(c,sql,args=()):
    with c.cursor() as cur: cur.execute(sql,args); return cur.fetchall() if cur.description else []
def state(c): return q(c,"SELECT * FROM stick_archive_scraper_state WHERE state_key='main'")[0]
def upd(c,**kw):
    allowed={'backfill_next_page','backfill_complete','status','run_id','current_page','pages_completed_latest','archived_latest','skipped_latest','failed_latest','last_error','heartbeat_at','last_success_at','run_started_at','run_finished_at'}; kw={k:v for k,v in kw.items() if k in allowed}
    if not kw:return
    sets=','.join(f'{k}=%s' for k in kw); q(c,f"UPDATE stick_archive_scraper_state SET {sets},updated_at=NOW() WHERE state_key='main'",tuple(kw.values())); c.commit()
def record_fail(c,it,p,e): q(c,"""INSERT INTO stick_archive_failures(source_url,detail_url,gallery_page,error_text,attempts,last_seen_at) VALUES(%s,%s,%s,%s,1,NOW()) ON CONFLICT(source_url) DO UPDATE SET detail_url=EXCLUDED.detail_url,gallery_page=EXCLUDED.gallery_page,error_text=EXCLUDED.error_text,attempts=stick_archive_failures.attempts+1,last_seen_at=NOW()""",(it.get('source_url') or it.get('download_url') or f'page:{p}',it.get('detail_url',''),p,str(e)[:1200])); c.commit()
def caption(it):
    t=' '.join('#'+re.sub(r'[^a-z0-9_]+','',x,flags=re.I) for x in it['tags'][:8]); return '\n'.join(x for x in [f"📦 <b>{html.escape(it['title'])}</b>",f"🗂 {html.escape(it['file_type'])} → {html.escape(it['category'])}",f"📄 <code>{html.escape(it['original_filename'])}</code>",f"📅 {html.escape(it['source_date'])}" if it['source_date'] else '',f"🏷 {html.escape(t)}" if t else '',f"🔗 <a href=\"{html.escape(it['detail_url'])}\">Original page</a>" if it['detail_url'] else ''] if x)[:1000]
def process(c,it,p):
    if q(c,'SELECT id FROM stick_archive_files WHERE source_url=%s AND telegram_file_id IS NOT NULL LIMIT 1',(it['source_url'],)): return 'skipped'
    try:
        it=hydrate(it); time.sleep(DELAY); r=get(it['download_url'],60); data=r.content
        if len(data)>MAX_BYTES: raise RuntimeError(f'file too large ({len(data)} bytes)')
        it['actual_size_bytes']=len(data); it['sha256']=hashlib.sha256(data).hexdigest()
        dup=q(c,'SELECT id FROM stick_archive_files WHERE sha256=%s AND telegram_file_id IS NOT NULL LIMIT 1',(it['sha256'],))
        if dup: q(c,'INSERT INTO stick_archive_aliases(source_url,file_id) VALUES(%s,%s) ON CONFLICT(source_url) DO UPDATE SET file_id=EXCLUDED.file_id',(it['source_url'],dup[0]['id'])); c.commit(); return 'duplicate'
        tr=requests.post(f'https://api.telegram.org/bot{TOKEN}/sendDocument',data={'chat_id':CHAT,'caption':caption(it),'parse_mode':'HTML'},files={'document':(it['original_filename'],data,r.headers.get('content-type','application/octet-stream'))},timeout=90); tr.raise_for_status(); msg=tr.json()['result']; doc=msg['document']
        q(c,"""INSERT INTO stick_archive_files(source_url,detail_url,source_page,title,normalized_title,original_filename,file_type,category,categories,tags,tags_text,creator,creator_handle,description,source_date,source_hits,pack_count,declared_size_bytes,actual_size_bytes,sha256,telegram_file_id,telegram_file_unique_id,telegram_message_id,archive_chat_id,updated_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW()) ON CONFLICT(source_url) DO UPDATE SET title=EXCLUDED.title,normalized_title=EXCLUDED.normalized_title,original_filename=EXCLUDED.original_filename,file_type=EXCLUDED.file_type,category=EXCLUDED.category,categories=EXCLUDED.categories,tags=EXCLUDED.tags,tags_text=EXCLUDED.tags_text,actual_size_bytes=EXCLUDED.actual_size_bytes,sha256=EXCLUDED.sha256,telegram_file_id=EXCLUDED.telegram_file_id,telegram_file_unique_id=EXCLUDED.telegram_file_unique_id,telegram_message_id=EXCLUDED.telegram_message_id,archive_chat_id=EXCLUDED.archive_chat_id,updated_at=NOW()""",(it['source_url'],it['detail_url'],it['source_page'],it['title'],norm(it['title']),it['original_filename'],it['file_type'],it['category'],it['categories'],it['tags'],' '.join(it['tags']),it['creator'],it['creator_handle'],it['description'],it['source_date'],it['source_hits'],it['pack_count'],it['declared_size_bytes'],it['actual_size_bytes'],it['sha256'],doc['file_id'],doc.get('file_unique_id',''),msg['message_id'],int(CHAT))); q(c,'DELETE FROM stick_archive_failures WHERE source_url=%s',(it['source_url'],)); c.commit(); time.sleep(UPLOAD_DELAY); return 'archived'
    except Exception as e: record_fail(c,it,p,e); print('[failed]',it.get('original_filename'),e); return 'failed'
def scrape(c,p):
    url=page_url(p); print('[scraper] listing page',p,url); items=parse_listing(get(url).text,url); counts={'archived':0,'skipped':0,'failed':0,'duplicate':0}
    for it in items: st=process(c,it,p); counts[st]+=1; print('[scraper]',st,it['original_filename'])
    return items,counts

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--mode',choices=['backfill','recent','both'],default='backfill'); ap.add_argument('--backfill-pages',type=int,default=25); ap.add_argument('--recent-pages',type=int,default=3); ap.add_argument('--start-page',type=int,default=0); a=ap.parse_args()
    with conn() as c:
        got=q(c,'SELECT pg_try_advisory_lock(%s) locked',(88442211,))[0]['locked']
        if not got: raise SystemExit('another scraper run already holds the database lock')
        try:
            st=state(c); totals={'archived':0,'skipped':0,'failed':0,'duplicate':0,'pages':0}; upd(c,status='running',run_started_at=datetime.now(timezone.utc),last_error='')
            pages=[]
            if a.mode in ('recent','both'): pages += list(range(1,a.recent_pages+1))
            if a.mode in ('backfill','both'):
                start=a.start_page if a.start_page>0 else max(1,int(st['backfill_next_page'] or 1)); pages += list(range(start,start+a.backfill_pages))
            seen=set()
            for p in pages:
                if p in seen: continue
                seen.add(p); upd(c,current_page=p,heartbeat_at=datetime.now(timezone.utc)); items,ct=scrape(c,p)
                if not items and a.mode in ('backfill','both'): upd(c,backfill_complete=True,current_page=p); break
                for k in ct: totals[k]+=ct[k]
                totals['pages']+=1
                if a.mode in ('backfill','both') and p>= (a.start_page if a.start_page>0 else int(st['backfill_next_page'] or 1)): upd(c,backfill_next_page=p+1)
                upd(c,pages_completed_latest=totals['pages'],archived_latest=totals['archived'],skipped_latest=totals['skipped']+totals['duplicate'],failed_latest=totals['failed'],last_success_at=datetime.now(timezone.utc),heartbeat_at=datetime.now(timezone.utc))
            upd(c,status='waiting',run_finished_at=datetime.now(timezone.utc),last_error=''); print('[done]',totals)
        except Exception as e: upd(c,status='stalled',run_finished_at=datetime.now(timezone.utc),last_error=str(e)[:1000]); raise
        finally: q(c,'SELECT pg_advisory_unlock(%s)',(88442211,)); c.commit()
if __name__=='__main__': main()