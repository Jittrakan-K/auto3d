# AUTO DESIGN 3D

สร้างโมเดล 3 มิติจากคำสั่งภาษาไทยหรือ Drawing ได้ไฟล์ STEP และมาโครที่สร้างไฟล์ SLDPRT ใน SOLIDWORKS 2018 ขึ้นไป

มี 2 แบบในโปรเจกต์เดียว
| | เว็บบน GitHub Pages (`docs/`) | แอปบนเครื่อง (`app/`) |
|---|---|---|
| เปิดใช้ | ลิงก์เว็บ ไม่ต้องติดตั้ง | `install.bat` แล้ว `start.bat` |
| STEP | ได้ | ได้ |
| มาโคร .swb สำหรับ SOLIDWORKS 2018 ขึ้นไป | ได้ | ได้ |
| สร้าง SLDPRT ให้ทันที | ไม่ได้ ใช้มาโครแทน | ได้ ผ่าน SOLIDWORKS ในเครื่อง |
| ใช้ AI ออกแบบ | ใช้แชต Claude Pro ได้ฟรี (คัดลอกคำสั่งไปวาง แล้ววางคำตอบกลับ) หรือใส่ API key ของตัวเองเพื่อให้ทำอัตโนมัติ | เก็บในไฟล์ `.env` บนเครื่อง |

## เปิดเว็บบน GitHub Pages
1. สร้าง repository ใหม่บน github.com ตั้งเป็น **Public** เช่นชื่อ `auto-design-3d` (Pages ฟรีใช้ได้กับ public repo)
2. อัปโหลดทุกไฟล์ในโฟลเดอร์นี้ขึ้น repo ด้วย GitHub Desktop (File › Add local repository › Publish) ไฟล์ใน `.gitignore` เช่น `.env` และ `.venv` จะไม่ถูกส่งขึ้นไป
3. ใน repo ไปที่ **Settings › Pages** เลือก Source เป็น **Deploy from a branch**, Branch **main**, Folder **/docs** แล้วกด Save
4. รอ 1 ถึง 2 นาที เว็บจะอยู่ที่ `https://ชื่อผู้ใช้.github.io/auto-design-3d/`

ครั้งแรกที่เปิด เว็บจะโหลดตัวสร้างโมเดลขนาดประมาณ 23 MB ครั้งต่อไปเบราว์เซอร์จะจำไว้
ไฟล์ `docs/index.html` ดับเบิลคลิกเปิดจากโฟลเดอร์ตรง ๆ ไม่ได้ ต้องเปิดผ่านลิงก์ Pages หรือเซิร์ฟเวอร์ เช่น `python -m http.server -d docs` แล้วเปิด `http://localhost:8000`

## แอปบนเครื่อง Windows
### ติดตั้ง
1. ดับเบิลคลิก `install.bat` (ครั้งแรกใช้เวลาหลายนาที และต้องต่ออินเทอร์เน็ต)
2. ดับเบิลคลิก `test_solidworks.bat` เพื่อทดสอบกับ SOLIDWORKS ในเครื่อง ผลอยู่ในไฟล์ `sw_test_log.txt`
3. ดับเบิลคลิก `start.bat` เว็บจะเปิดเองที่ http://127.0.0.1:8765
4. กดปุ่ม **ตั้งค่า** แล้วใส่ Claude API key จาก platform.claude.com

ปุ่มชิ้นงานตัวอย่างใช้ได้ทันทีโดยไม่ต้องมี API key

### วิธีใช้
1. พิมพ์คำสั่ง หรือแนบ Drawing (PDF, รูปภาพ, DXF) แล้วกด **สร้างโมเดล**
2. ตรวจตารางขนาด ค่าที่มีป้าย "ค่าประมาณ" คือค่าที่ AI เดาเอง ต้องตรวจก่อนใช้
3. แก้ตัวเลขแล้วกด **อัปเดตโมเดล** ได้ทันที ไม่เสียค่า AI
4. อยากแก้รูปทรง ให้พิมพ์คำสั่งเพิ่ม เช่น "เพิ่มรูตรงกลาง Ø20" แล้วกด **สร้างโมเดล**
5. กด **ดาวน์โหลด STEP**, **สร้าง SLDPRT** หรือ **ดาวน์โหลดมาโคร**

ไฟล์ทุกงานอยู่ในโฟลเดอร์ `output`

## ไฟล์ที่ได้
| ไฟล์ | สร้างโดย | หมายเหตุ |
|---|---|---|
| `.step` | เว็บนี้ ไม่ต้องใช้ SOLIDWORKS | STEP AP214 เปิดได้ในทุกเวอร์ชัน แต่เป็น Solid ไม่มี Feature Tree |
| `_SW2025.SLDPRT` | SOLIDWORKS ในเครื่องนี้ | มี Feature Tree รุ่นไฟล์ตรงกับรุ่นโปรแกรมที่ใช้สร้าง |
| `.swb` | เว็บนี้ | มาโคร ใช้ใน SOLIDWORKS ที่เมนู Tools, Macro, Run ถ้าเลือกไฟล์ไม่ได้ให้สร้างมาโครใหม่แล้ววางข้อความลงไป |

## ถ้าต้องการไฟล์รุ่น 2018
ไฟล์ SLDPRT จะเป็นรุ่นเดียวกับโปรแกรมที่เซฟเสมอ SOLIDWORKS 2025 เซฟย้อนหลังได้ถึง 2023 จึงสร้างไฟล์รุ่น 2018 ไม่ได้
- นำไฟล์ `.swb` ไปรันบนเครื่องที่มี SOLIDWORKS 2018 จะได้ SLDPRT รุ่น 2018 พร้อม Feature Tree ในโฟลเดอร์เดียวกับมาโคร
- หรือส่งไฟล์ STEP เปิดใน 2018 ได้ทันที แต่ไม่มี Feature Tree

## การทำงาน
```
คำสั่ง / Drawing -> Claude เขียนแผนฟีเจอร์ JSON -> ตรวจรูปแบบและสร้างด้วย OpenCASCADE
                                                   |-> STEP + ภาพ 3D บนเว็บ
                                                   |-> SOLIDWORKS สร้างทีละฟีเจอร์
                                                       แล้วเทียบปริมาตรและจุดศูนย์ถ่วงกับ STEP
```
AI ส่งเพียงแผน JSON ระบบไม่รันโค้ดที่ AI เขียน ถ้าแผนผิด ข้อผิดพลาดจะส่งกลับให้ AI แก้สูงสุด 4 รอบ

## ผลทดสอบ
- ทดสอบกับ SOLIDWORKS 2025 SP4 จริงด้วยชิ้นงานตัวอย่าง 4 ชิ้น ทั้งการสร้างผ่าน `test_solidworks.bat` และการรันมาโคร `.swb` ที่เมนู Tools, Macro, Run ปริมาตรและจุดศูนย์ถ่วงตรงกับ STEP ทุกฟีเจอร์
- เว็บ GitHub Pages ได้ปริมาตร จุดศูนย์ถ่วงทุกฟีเจอร์ และข้อความมาโครตรงกับแอปบนเครื่องทั้ง 4 ชิ้น ตรวจด้วย `tools/parity.mjs`
- ยังไม่ได้ทดสอบกับ SOLIDWORKS 2018 จริง คำสั่ง API ที่มาโครใช้มีอยู่ในคู่มือรุ่น 2018 แต่ถ้ามาโครแจ้งฟีเจอร์ที่ต้องตรวจ ให้ตรวจฟีเจอร์นั้นใน SOLIDWORKS
- ยังไม่ได้ทดสอบกับ Claude API จริง เพราะต้องใช้ API key ของคุณ

## ขอบเขต
- สร้างได้: Extrude, Cut, Revolve, Hole (รวม Counterbore และ Countersink), Fillet, Chamfer
- ยังไม่รองรับ: Assembly, Sheet Metal, Loft, Sweep, เกลียวจริง, การสร้าง Drawing
- สเก็ตช์ใน SLDPRT ยังไม่มี Dimension และ Relation แต่ความลึกของฟีเจอร์แก้ได้ตามปกติ
- ไม่อ่าน DWG ให้ Save As เป็น DXF หรือ PDF ก่อน
- โมเดลจาก Drawing ต้องให้วิศวกรตรวจก่อนนำไปผลิตเสมอ

## ค่าตั้งใน .env
| ชื่อ | ใช้ทำอะไร |
|---|---|
| `ANTHROPIC_API_KEY` | คีย์ Claude |
| `AUTODESIGN_MODEL` | โมเดล AI |
| `AUTODESIGN_SW_TEMPLATE` | ที่อยู่เทมเพลต Part หากหาอัตโนมัติไม่เจอ |
| `AUTODESIGN_PORT` | พอร์ตของเว็บ ค่าเริ่มต้น 8765 |

## สำหรับนักพัฒนา
```
app/            เว็บเซิร์ฟเวอร์ (FastAPI) และหน้าเว็บ
  plan.py       รูปแบบแผนฟีเจอร์ JSON ที่ AI เขียน
  cad_engine.py สร้างรูปทรงด้วย OpenCASCADE และส่งออก STEP/STL
  sw_backend.py สั่ง SOLIDWORKS ผ่าน COM แล้วเทียบผลกับ STEP ทุกฟีเจอร์
  sw_macro.py   เขียนมาโคร .swb ที่ใช้ได้ใน SOLIDWORKS 2018 ขึ้นไป
  ai_planner.py เรียก Claude และส่งข้อผิดพลาดกลับให้แก้
  static/       หน้าเว็บ HTML5 แบบแผ่นแบบงาน
examples/       ชิ้นงานตัวอย่าง
tests/          ชุดทดสอบ (รันได้ทุกระบบ ไม่ต้องมี SOLIDWORKS)
docs/           เว็บ GitHub Pages ทำงานในเบราว์เซอร์ล้วน
  js/plan.js    ตรวจแผน JSON (กฎเดียวกับ app/plan.py)
  js/cad.js     สร้างรูปทรงด้วย OpenCASCADE WebAssembly
  js/macro.js   เขียนมาโคร .swb (ข้อความเดียวกับ app/sw_macro.py)
  js/ai.js      เรียก Claude จากเบราว์เซอร์ด้วยคีย์ของผู้ใช้
tools/          คัดลอกกฎไป docs/ และตรวจว่าเว็บได้ผลเหมือนแอปบนเครื่อง
design/         ไฟล์ดีไซน์และภาพเรนเดอร์ชิ้นงานตัวอย่าง
```
- ติดตั้งสำหรับพัฒนา: `pip install -r requirements-dev.txt` แล้วรัน `python -m pytest`
- คัดลอก `.env.example` เป็น `.env` แล้วใส่ API key ไฟล์ `.env` ไม่ถูกส่งขึ้น GitHub
- แก้ `app/plan.py`, `app/sw_macro.py` หรือ `examples/` แล้วรัน `python -m tools.export_web_assets` เพื่ออัปเดต `docs/`
- ตรวจว่าเว็บได้ผลเหมือนแอป: `python -m tools.dump_reference` แล้ว `cd tools && npm install && npm run parity`
- เอาขึ้น GitHub: เปิดโฟลเดอร์นี้ใน GitHub Desktop แล้วเลือก Add local repository หรือรัน `git init`, `git add .`, `git commit -m "AUTO DESIGN 3D"` แล้ว push

## สัญญาอนุญาตของส่วนประกอบ
- OpenCASCADE ผ่าน replicad-opencascadejs: LGPL-2.1 (`docs/vendor/kernel/opencascade.LICENSE`)
- replicad: MIT (`docs/vendor/kernel/replicad.LICENSE`)
- three.js: MIT (`docs/vendor/three.LICENSE`)
- ฟอนต์ IBM Plex: SIL Open Font License
- ฟอนต์ Press Start 2P (โลโก้): SIL Open Font License
