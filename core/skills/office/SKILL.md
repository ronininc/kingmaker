---
name: office
description: >-
  Make Word documents, Excel spreadsheets, PowerPoint decks and PDFs: letters, proposals, menus, flyers, price lists,
  inventories, invoices, schedules, slide decks, and merging, splitting, stamping or filling PDF forms.
kingmaker-renderer: office
---

# Office files

You don't write the file yourself. You answer with ONE JSON object in a ```json block, and Kingmaker turns it into the
real file in the owner's Documents/Kingmaker folder. Write real content, from what the owner said and what you know; never
invent prices, phone numbers, addresses or names. If something is missing, leave a clear blank like "[phone]".

Pick the kind from what they asked: a document or letter → "docx"; numbers, lists, prices, a table to sort → "xlsx";
slides or a deck → "pptx"; a PDF, or something to print as-is → "pdf".

## docx
{"kind":"docx","title":"…","subtitle":"…","sections":[{"heading":"…","paragraphs":["…"],"bullets":["…"],"numbered":["…"],"table":{"header":["…"],"rows":[["…"]]}}]}

## xlsx
{"kind":"xlsx","title":"…","sheets":[{"name":"…","header":["Item","Price","Qty"],"rows":[["Taco",3.5,2]],"money":[1],"total":true}]}
- Numbers as numbers, not text. "money" lists the columns (from 0) shown as dollars. "total": true adds a total row.
- A cell that is worked out from others is a formula: "=B2+C2" (row 1 is the header, so the first data row is row 2).
  A tracker to fill in later: leave the inputs 0 and make the totals formulas.

## pptx
{"kind":"pptx","title":"…","subtitle":"…","slides":[{"title":"…","bullets":["…"],"notes":"what to say"}]}
- 3 to 6 short bullets a slide. The cover slide is made from the title.

## pdf
- New PDF: {"kind":"pdf","title":"…","sections":[{"heading":"…","paragraphs":["…"],"bullets":["…"]}]}
- Merge: {"kind":"pdf","title":"…","merge":["/full/path/a.pdf","/full/path/b.pdf"]}
- Keep pages: {"kind":"pdf","title":"…","split":{"path":"/full/path/a.pdf","pages":"1-3, 5"}}
- Stamp every page: {"kind":"pdf","title":"…","stamp":{"path":"/full/path/a.pdf","text":"PAID"}}
- Fill a form: {"kind":"pdf","title":"…","fill":{"path":"/full/path/form.pdf","values":{"field_name":"value"}}}
- Only use paths the owner gave you.

After the JSON, one short sentence saying what the file is.
