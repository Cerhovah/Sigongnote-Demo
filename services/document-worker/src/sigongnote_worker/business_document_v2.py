"""Construction business forms: explicit parties, blank seals, frozen amounts."""
import io
import math
import unicodedata
from html import escape
from decimal import Decimal
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from .export_batch import _font_path
from .business_document import amount, display_text, NAMES

PARTY_FIELDS = [("business_number", "사업자등록번호"), ("representative", "대표자"), ("address", "주소"), ("business_type", "업태"), ("business_item", "종목"), ("contact", "담당자·연락처")]
NOTICE = "일반 업무 문서 · 발행은 전달·인수·입금 완료를 뜻하지 않습니다."


def party(snapshot, side):
    details = snapshot.get("form", {}).get(side, {})
    return [("상호", snapshot[side]["name"])] + [(label, details.get(key) or "—") for key, label in PARTY_FIELDS if key not in ("business_type","business_item","contact")] + [("업태 / 종목", (details.get("business_type") or "—")+" / "+(details.get("business_item") or "—")), ("담당자·연락처", details.get("contact") or "—")]


def conditions(snapshot):
    form, kind = snapshot.get("form", {}), snapshot["type"]
    keys = []
    if kind == "estimate": keys.append(("valid_until", "견적 유효일"))
    if kind in ("purchase_order", "delivery_statement"):
        keys += [("delivery_date", "희망 납품일" if kind == "purchase_order" else "거래일"), ("delivery_place", "납품 장소")]
    keys.append(("payment_terms", "결제 조건"))
    if kind in ("estimate", "invoice"): keys.append(("payment_account", "입금 계좌·예금주"))
    keys.append(("note", "비고"))
    return [(label, form.get(key) or "—") for key, label in keys]


def render_pdf(snapshot):
    font = "SigongnoteBusinessKorean"
    if font not in pdfmetrics.getRegisteredFontNames(): pdfmetrics.registerFont(TTFont(font, str(_font_path())))
    body = ParagraphStyle("business-v2", fontName=font, fontSize=9, leading=13, wordWrap="CJK")
    title = ParagraphStyle("title-v2", parent=body, fontSize=24, leading=32, spaceAfter=12)
    p = lambda value: Paragraph(escape(display_text(value)).replace("\n", "<br/>"), body)
    table_style = [("GRID", (0, 0), (-1, -1), .4, colors.HexColor("#AAB4C0")), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]
    def block(rows, widths, heading=True, **kwargs):
        t = Table([[p(v) for v in row] for row in rows], colWidths=widths, hAlign="LEFT", **kwargs)
        t.setStyle(TableStyle(table_style + ([("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EDF1F5"))] if heading else [])))
        return t
    parties = [["보내는 업체 (발행자)", "받는 업체"]]
    parties += [[f"{a}: {b}", f"{c}: {d}"] for (a,b),(c,d) in zip(party(snapshot,"issuer"),party(snapshot,"recipient"))]
    content = [Paragraph(NAMES[snapshot["type"]], title), p(f"문서번호 {snapshot['document_number']}   |   작성일 {snapshot['date']}"), p(f"현장: {snapshot['project']['name']}"), Spacer(1,10), block(parties,[255.5,255.5]), Spacer(1,8)]
    # Dedicated physical space, never an image of an invented seal.
    seal = Table([[p("발행자 직인"), p("날인란 (빈칸)")]], colWidths=[100,411], rowHeights=[45], hAlign="LEFT")
    seal.setStyle(TableStyle(table_style + [("VALIGN",(0,0),(-1,-1),"MIDDLE")]))
    content += [seal,Spacer(1,12)]
    rows = [["No.","품명 · 규격","단위","수량","단가","공급가액","부가세"]]
    for n,line in enumerate(snapshot["lines"],1):
        rows.append([str(n),line["description"]+("\n"+line["spec"] if line["spec"] else ""),line["unit"],line["quantity"] if line["quantity"] is not None else "확인 필요",amount(line["unit_price"]),amount(line["supply"]),amount(line["tax"])])
    content += [block(rows,[26,149,30,44,82,92,88],repeatRows=1),Spacer(1,8)]
    content += [block([["공급가액", "부가세", "합계 (원)"],[amount(snapshot['totals'][k]) for k in ['supply','tax','total']]],[170,170,171]),Spacer(1,8),block(conditions(snapshot),[100,411],False)]
    if snapshot["type"] == "delivery_statement":
        content += [Spacer(1,8),p("인수 확인란 (별도 확인)"),block([["성명", "서명·직인", "일자"]],[155,201,155],False,rowHeights=[45])]
    content += [Spacer(1,8)] + [p(t) for t in snapshot["terms"]] + [p(NOTICE)]
    if snapshot['type']=='invoice': content.append(p("법정 전자세금계산서가 아닙니다."))
    stream=io.BytesIO()
    doc=SimpleDocTemplate(stream,pagesize=A4,leftMargin=42,rightMargin=42,topMargin=34,bottomMargin=42,title=NAMES[snapshot['type']],author='시공노트')
    def footer(canvas, doc):
        canvas.setFont(font,8);canvas.drawString(42,22,f"시공노트 업무 양식 2.0 · {snapshot['document_number']}");canvas.drawRightString(A4[0]-42,22,str(doc.page))
    doc.build(content,onFirstPage=footer,onLaterPages=footer)
    return stream.getvalue()


def render_xlsx(snapshot):
    book=Workbook();sheet=book.active;sheet.title=NAMES[snapshot['type']];book.properties.creator='시공노트'
    widths=[6,27,22,9,12,18,20,18]
    border=Border(*( [Side(style='thin',color='AAB4C0')]*4 ))
    def text(row,col,value,end=None):
        if end and end>col: sheet.merge_cells(start_row=row,start_column=col,end_row=row,end_column=end)
        c=sheet.cell(row,col,display_text(value));c.data_type='s';c.font=Font(name='맑은 고딕',size=10,color='172B4D');c.alignment=Alignment(wrap_text=True,vertical='center');c.border=border
        span=sum(widths[col-1:(end or col)])-2
        lines=sum(max(1,math.ceil(sum(2 if unicodedata.east_asian_width(ch) in ('W','F') else 1 for ch in part)/max(1,span))) for part in display_text(value).split('\n'))
        sheet.row_dimensions[row].height=max(sheet.row_dimensions[row].height or 0,16*(lines+1))
        return c
    def number(row,col,value):
        c=text(row,col,amount(value) if value is None else value)
        if value is not None and len(value.replace('-','').replace('.','').lstrip('0'))<=15:
            c.value=int(value) if '.' not in value else float(Decimal(value));c.number_format='#,##0'+('.'+'0'*len(value.split('.')[1].rstrip('0')) if '.' in value and value.split('.')[1].rstrip('0') else '')
        c.alignment=Alignment(horizontal='right',vertical='center');return c
    text(1,1,sheet.title,8).font=Font(name='맑은 고딕',size=24,bold=True);sheet.row_dimensions[1].height=42
    text(2,1,f"문서번호 {snapshot['document_number']}   |   작성일 {snapshot['date']}",8)
    text(3,1,f"현장: {snapshot['project']['name']}",8)
    text(5,1,'보내는 업체 (발행자)',4);text(5,5,'받는 업체',8)
    for r,((a,b),(c,d)) in enumerate(zip(party(snapshot,'issuer'),party(snapshot,'recipient')),6): text(r,1,f'{a}: {b}',4);text(r,5,f'{c}: {d}',8)
    text(13,1,'발행자 직인',3);text(13,4,'날인란 (빈칸)',8);sheet.row_dimensions[13].height=48
    for c,label in enumerate(['No.','품명','규격','단위','수량','단가','공급가액','부가세'],1): text(15,c,label).fill=PatternFill('solid',fgColor='EDF1F5')
    for r,line in enumerate(snapshot['lines'],16):
        number(r,1,str(r-15))
        for c,key in enumerate(['description','spec','unit'],2): text(r,c,line[key])
        for c,key in enumerate(['quantity','unit_price','supply','tax'],5): number(r,c,line[key])
    row=16+len(snapshot['lines'])
    for label,key in [('공급가액','supply'),('부가세','tax'),('합계 (원)','total')]:
        text(row,1,label,6);sheet.merge_cells(start_row=row,start_column=7,end_row=row,end_column=8);number(row,7,snapshot['totals'][key]);row+=1
    row+=1
    for label,value in conditions(snapshot): text(row,1,label,3);text(row,4,value,8);row+=1
    if snapshot['type']=='delivery_statement':
        text(row,1,'인수 확인란 (별도 확인)',8);row+=1
        text(row,1,'성명',3);text(row,4,'서명·직인',6);text(row,7,'일자',8);sheet.row_dimensions[row].height=48;row+=1
    for term in snapshot['terms']+[NOTICE]+(['법정 전자세금계산서가 아닙니다.'] if snapshot['type']=='invoice' else []): text(row,1,term,8);row+=1
    for col,width in zip('ABCDEFGH',widths): sheet.column_dimensions[col].width=width
    sheet.freeze_panes='A16';sheet.print_title_rows='15:15';sheet.print_area=f'A1:H{row-1}'
    sheet.page_setup.orientation='portrait';sheet.page_setup.paperSize=sheet.PAPERSIZE_A4;sheet.page_setup.fitToWidth=1;sheet.page_setup.fitToHeight=0;sheet.sheet_properties.pageSetUpPr.fitToPage=True
    sheet.oddFooter.center.text='&P / &N';stream=io.BytesIO();book.save(stream);return stream.getvalue()
