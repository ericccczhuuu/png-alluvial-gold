const {chromium}=require('playwright');const fs=require('fs');
const E=JSON.parse(fs.readFileSync('calc-expected.json'));
(async()=>{const b=await chromium.launch();const p=await b.newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));
await p.goto('file://'+process.cwd()+'/index.html');await p.waitForTimeout(500);
const res=[];const chk=(name,got,exp,tol)=>{const ok=Math.abs(got-exp)<=tol;res.push(`${ok?'PASS':'FAIL'} ${name}: page=${got} expected=${exp.toFixed?exp.toFixed(5):exp}`)};
const num=s=>parseFloat(String(s).replace(/,/g,''));
async function fill(sel,v){await p.evaluate(([s,v])=>{const e=document.querySelector(s);e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))},[sel,String(v)])}
const grade=async()=>p.evaluate(()=>[...document.querySelectorAll('#m-preview b')].map(b=>b.textContent));
// pit
await fill('#m-vmode','pit');await fill('#m-l',2);await fill('#m-w',1);await fill('#m-d',1.5);await fill('#m-gold',900);await fill('#m-fine',85);
let g=await grade();chk('pit volume',num(g[0]),3,0.001);chk('pit grade',num(g[1]),E.pit,0.001);chk('pit fine grade',num(g[2]),E.pit_fine,0.001);
await fill('#m-fine','');await fill('#m-vmode','pans');await fill('#m-pans',47);await fill('#m-pf',235);await fill('#m-gold',60);
g=await grade();chk('pans grade',num(g[1]),E.pans,0.001);
await fill('#m-vmode','loose');await fill('#m-loose',10);await fill('#m-lunit','bucket');await fill('#m-swell',25);await fill('#m-gold',48);
g=await grade();chk('loose volume',num(g[0]),0.16,0.001);chk('loose grade',num(g[1]),E.loose,0.001);
// pan calc default
let pc=await p.evaluate(()=>[...document.querySelectorAll('#pc-out b')].map(b=>b.textContent));chk('pan calc grade',num(pc[1]),E.pc,0.0006);
// unit conv
const uc=await p.evaluate(()=>[...document.querySelectorAll('#uc-out td.n')].map(t=>t.textContent));
chk('oz/yd3',num(uc[2]),E.uc_oz,0.0001);chk('dwt/yd3',num(uc[3]),E.uc_dwt,0.001);chk('g/yd3',num(uc[4]),E.uc_gyd,0.001);chk('loose g/m3',num(uc[5]),E.uc_loose,0.001);
// model
const st=await p.evaluate(()=>[...document.querySelectorAll('#r-stats .v')].map(x=>x.textContent));chk('annual oz',num(st[1]),E.oz,1);chk('gross US$m',num(st[2]),E.gross_m,0.01);
const rows=await p.evaluate(()=>[...document.querySelectorAll('#r-table tr')].slice(1,6).map(r=>[...r.querySelectorAll('td')].map(t=>t.textContent)));
chk('A landowner',num(rows[0][1]),E.A_land,0.01);chk('A profit',num(rows[0][3]),E.A_profit,0.01);chk('A after-tax',num(rows[0][4]),E.A_after,0.01);chk('A payback',num(rows[0][5]),E.A_payback,0.1);chk('A breakeven',num(rows[0][6]),E.A_be,0.001);
chk('B breakeven',num(rows[1][6]),E.B_be,0.001);chk('C profit',num(rows[2][3]),E.C_profit,0.01);chk('C breakeven',num(rows[2][6]),E.C_be,0.001);chk('D profit',num(rows[3][3]),E.D_profit,0.01);chk('D breakeven',num(rows[3][6]),E.D_be,0.001);chk('E profit',num(rows[4][3]),E.E_profit,0.01);
// heatmap cell grade .3 price 4000 approx A profit at 4000
const hm=await p.evaluate(()=>{const t=document.querySelector('#heat');const r=[...t.rows].find(r=>r.cells[0].textContent==='0.3');return r.cells[4].textContent});
const P4=4000/31.1035,gross4=24000*P4*0.95;chk('heatmap 0.3@4000',num(hm),(gross4*(1-0.025-0.15)-1e6)/1e6,0.01);
// cashflow simple case
await fill('#cf-lead',0);await fill('#cf-ramp',0);await fill('#cf-wet',0);
const note=await p.evaluate(()=>document.querySelector('#cf-note').textContent);
const m=note.match(/US\$([-\d.,]+)m.*第 (\d+) 个月/);chk('cashflow end',num(m[1]),E.cf_end,0.01);chk('cashflow payback month',+m[2],E.cf_payback_month,0);
console.log(res.join('\n'));console.log('errors',JSON.stringify(errs));await b.close()})();
