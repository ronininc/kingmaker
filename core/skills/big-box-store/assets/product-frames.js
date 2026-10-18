/* ==========================================================================
   GENERATED PRODUCT FRAMES
   Five swipeable frames per item, drawn as SVG data-URIs in the browser from
   the store's own export. No files, no bandwidth, no service — which is why
   this scales to 1,948 products at zero operational cost.

   HARD RULE: a frame may only state a fact that is present in the export.
   Nothing here invents a pack size, a price, or an image of a product. Where a
   fact is absent the frame says so rather than guessing.
   ========================================================================== */
(function(){
'use strict';

var PAL = {
  'desechables'       : ['#1d2b3a','#5b8db8','#dce9f4'],
  'abarrotes-basicos' : ['#3a2a12','#c08a2e','#f4e6c8'],
  'especias-y-chiles' : ['#3a1410','#a8341c','#f0d0c0'],
  'salsas-y-sazonador': ['#3a1a08','#c85a1e','#f6ddc6'],
  'snacks-y-dulces'   : ['#331436','#b8399a','#f7d8ef'],
  'limpieza-y-hogar'  : ['#0d2e2b','#2e9c8e','#cdeee9'],
  'sin-categoria'     : ['#26241f','#8a8578','#e6e3db']
};
function pal(k){ return PAL[k] || PAL['sin-categoria']; }

function esc(s){
  return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}
function uri(svg){
  return 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600">'+svg+'</svg>');
}
/* wrap a long product name into <=n lines of <=per chars */
function wrap(s, per, n){
  var w=String(s).split(/\s+/), lines=[], cur='';
  for(var i=0;i<w.length;i++){
    var t = cur ? cur+' '+w[i] : w[i];
    if(t.length>per && cur){ lines.push(cur); cur=w[i]; if(lines.length===n-1){} }
    else cur=t;
  }
  if(cur) lines.push(cur);
  if(lines.length>n){ lines=lines.slice(0,n); lines[n-1]=lines[n-1].replace(/.{1}$/,'…'); }
  return lines;
}
function textBlock(lines, x, y, size, fill, weight, anchor){
  var o='';
  for(var i=0;i<lines.length;i++){
    o+='<text x="'+x+'" y="'+(y+i*size*1.22)+'" font-family="Outfit,system-ui,sans-serif" '+
       'font-size="'+size+'" font-weight="'+(weight||700)+'" fill="'+fill+'" '+
       'text-anchor="'+(anchor||'middle')+'">'+esc(lines[i])+'</text>';
  }
  return o;
}

/* ---- fact extraction from the product name (never invented) -------------- */
var QTY = /(\d+(?:\.\d+)?)\s*(pzs?|piezas|ct|oz|ml|lts?|lbs?|kgs?|grs?|g|pack|pk)\b/i;
var DIM = /\b(\d+(?:\.\d+)?x\d+(?:\.\d+)?(?:x\d+(?:\.\d+)?)?)\b/i;
function packOf(it){
  var d = DIM.exec(it.name);
  if(d) return {big:d[1], small:'size'};
  var q = QTY.exec(it.name);
  if(q){
    var u=q[2].toLowerCase();
    u = /^pzs?$|^piezas$/.test(u) ? 'pieces' : (u==='ct'?'count':u);
    return {big:q[1], small:u};
  }
  return null;
}

/* ---- frame 1: product plate --------------------------------------------- */
function fProduct(it){
  var c=pal(it.topSlug), lines=wrap(it.name, 22, 4);
  var g='<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">'+
        '<stop offset="0" stop-color="'+c[2]+'"/><stop offset="1" stop-color="#fff"/>'+
        '</linearGradient></defs><rect width="600" height="600" fill="url(#g)"/>';
  /* a simple, honest silhouette keyed to the shelf — a drawing, not a photo */
  var art='<g opacity=".22" fill="'+c[0]+'">'+
    '<rect x="170" y="215" width="260" height="180" rx="14"/>'+
    '<rect x="196" y="176" width="208" height="52" rx="12" opacity=".7"/>'+
    '</g>';
  return uri(g+art+
    '<rect x="0" y="0" width="600" height="8" fill="'+c[1]+'"/>'+
    textBlock(lines, 300, 452, 30, c[0], 800)+
    '<text x="300" y="566" font-family="Outfit,system-ui,sans-serif" font-size="19" '+
    'font-weight="800" letter-spacing="3" fill="'+c[1]+'" text-anchor="middle">'+
    esc(String(it.subEn||'').toUpperCase())+'</text>');
}

/* ---- frame 2: pack / size ------------------------------------------------ */
function fPack(it){
  var c=pal(it.topSlug), p=packOf(it);
  var body = p
    ? '<text x="300" y="322" font-family="Outfit,system-ui,sans-serif" font-size="132" '+
      'font-weight="900" fill="#fff" text-anchor="middle">'+esc(p.big)+'</text>'+
      '<text x="300" y="382" font-family="Outfit,system-ui,sans-serif" font-size="30" '+
      'font-weight="700" letter-spacing="6" fill="'+c[2]+'" text-anchor="middle">'+
      esc(p.small.toUpperCase())+'</text>'
    : '<text x="300" y="300" font-family="Outfit,system-ui,sans-serif" font-size="34" '+
      'font-weight="800" fill="'+c[2]+'" text-anchor="middle">Pack size</text>'+
      '<text x="300" y="350" font-family="Outfit,system-ui,sans-serif" font-size="26" '+
      'font-weight="600" fill="#fff" text-anchor="middle" opacity=".75">not in the export</text>'+
      '<text x="300" y="392" font-family="Outfit,system-ui,sans-serif" font-size="19" '+
      'font-weight="600" fill="'+c[2]+'" text-anchor="middle" opacity=".6">ask at the counter</text>';
  return uri('<rect width="600" height="600" fill="'+c[0]+'"/>'+
    '<rect x="0" y="0" width="600" height="8" fill="'+c[1]+'"/>'+
    '<text x="300" y="170" font-family="Outfit,system-ui,sans-serif" font-size="20" '+
    'font-weight="800" letter-spacing="5" fill="'+c[1]+'" text-anchor="middle">PACK</text>'+body);
}

/* ---- frame 3: spec panel ------------------------------------------------- */
function fSpec(it){
  var c=pal(it.topSlug), y=196, o='', rows=[
    ['SKU',      it.sku      || '—'],
    ['Brand',    it.brand    || 'Not listed'],
    ['Supplier', it.supplier || 'Not listed'],
    ['Category', it.subEn    || '—']
  ];
  for(var i=0;i<rows.length;i++){
    o+='<text x="70" y="'+y+'" font-family="Outfit,system-ui,sans-serif" font-size="19" '+
       'font-weight="800" letter-spacing="3" fill="'+c[1]+'">'+esc(rows[i][0].toUpperCase())+'</text>'+
       '<text x="70" y="'+(y+40)+'" font-family="Outfit,system-ui,sans-serif" font-size="27" '+
       'font-weight="700" fill="#1a1a17">'+esc(String(rows[i][1]).slice(0,26))+'</text>'+
       '<rect x="70" y="'+(y+62)+'" width="460" height="1" fill="#1a1a17" opacity=".12"/>';
    y+=98;
  }
  return uri('<rect width="600" height="600" fill="#f7f5f0"/>'+
    '<rect x="0" y="0" width="600" height="8" fill="'+c[1]+'"/>'+
    '<text x="70" y="120" font-family="Outfit,system-ui,sans-serif" font-size="34" '+
    'font-weight="900" fill="#1a1a17">Specification</text>'+o);
}

/* ---- frame 4: price ------------------------------------------------------ */
function fPrice(it){
  var c=pal(it.topSlug);
  var body = (it.price!=null)
    ? '<text x="300" y="330" font-family="Outfit,system-ui,sans-serif" font-size="112" '+
      'font-weight="900" fill="#1a1a17" text-anchor="middle">$'+it.price.toFixed(2)+'</text>'+
      '<text x="300" y="386" font-family="Outfit,system-ui,sans-serif" font-size="21" '+
      'font-weight="700" letter-spacing="4" fill="#1a1a17" opacity=".55" text-anchor="middle">RETAIL &middot; PER UNIT</text>'
    : '<text x="300" y="316" font-family="Outfit,system-ui,sans-serif" font-size="48" '+
      'font-weight="900" fill="#1a1a17" text-anchor="middle">Ask in store</text>'+
      '<text x="300" y="366" font-family="Outfit,system-ui,sans-serif" font-size="21" '+
      'font-weight="600" fill="#1a1a17" opacity=".55" text-anchor="middle">no price in the export</text>';
  var stock = (it.stock!=null && it.stock>0)
    ? '<text x="300" y="470" font-family="Outfit,system-ui,sans-serif" font-size="22" '+
      'font-weight="800" letter-spacing="3" fill="#1f7a4d" text-anchor="middle">IN STOCK</text>'
    : '<text x="300" y="470" font-family="Outfit,system-ui,sans-serif" font-size="22" '+
      'font-weight="800" letter-spacing="3" fill="#8a6a1e" text-anchor="middle">CHECK AVAILABILITY</text>';
  return uri('<rect width="600" height="600" fill="'+c[2]+'"/>'+
    '<rect x="0" y="0" width="600" height="8" fill="'+c[1]+'"/>'+
    '<text x="300" y="180" font-family="Outfit,system-ui,sans-serif" font-size="20" '+
    'font-weight="800" letter-spacing="5" fill="'+c[0]+'" text-anchor="middle">PRICE</text>'+
    body+stock);
}

/* ---- frame 5: the open slot ---------------------------------------------
   Deliberately not decorative. This frame exists to be replaced by a real
   photograph, and it says so, so nobody mistakes the generated set for one. */
function fSlot(it){
  var c=pal(it.topSlug);
  return uri('<rect width="600" height="600" fill="#14130f"/>'+
    '<rect x="0" y="0" width="600" height="8" fill="'+c[1]+'"/>'+
    '<rect x="112" y="176" width="376" height="248" rx="10" fill="none" stroke="'+c[1]+
    '" stroke-width="2.5" stroke-dasharray="12 10" opacity=".8"/>'+
    '<g fill="'+c[1]+'" opacity=".85" transform="translate(276 252) scale(1.9)">'+
    '<path d="M12 3l4 4h-3v6h-2V7H8l4-4z"/><path d="M5 14v5h14v-5h2v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5h2z"/></g>'+
    '<text x="300" y="372" font-family="Outfit,system-ui,sans-serif" font-size="25" '+
    'font-weight="800" fill="#fff" text-anchor="middle">Photo goes here</text>'+
    '<text x="300" y="474" font-family="Outfit,system-ui,sans-serif" font-size="19" '+
    'font-weight="600" fill="#fff" opacity=".6" text-anchor="middle">Snap this item in the aisle —</text>'+
    '<text x="300" y="504" font-family="Outfit,system-ui,sans-serif" font-size="19" '+
    'font-weight="600" fill="#fff" opacity=".6" text-anchor="middle">it replaces this card everywhere.</text>');
}

/* ---- public -------------------------------------------------------------
   Real photos always come FIRST and push generated frames back, so a product
   with two real photos shows those two, then the generated set behind them. */
window.buildFrames = function(it){
  var real = (window.PRODUCT_PHOTOS && window.PRODUCT_PHOTOS[it.key]) || [];
  var made = [fProduct(it), fPack(it), fSpec(it), fPrice(it)];
  if(!real.length) made.push(fSlot(it));
  return real.concat(made);
};
})();
