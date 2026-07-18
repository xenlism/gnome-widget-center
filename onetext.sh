# คำสั่งนี้จะหาไฟล์ทั้งหมด (ยกเว้นโฟลเดอร์ .git และไฟล์รูปภาพ) 
# แล้วรวมเนื้อหาพร้อมใส่ชื่อไฟล์กำกับไว้ในไฟล์ชื่อ project_context.txt

find . -type f \
  -not -path './.git/*' \
  -not -name '*.png' \
  -not -name '*.jpg' \
  -not -name '*.zip' \
  -not -name '*.gschemas.compiled' \
  | sort | while IFS= read -r file; do
    echo "========================================"
    echo "FILE: $file"
    echo "========================================"
    cat "$file"
    echo -e "\n\n"
done > project_context.txt

echo "✅ รวมไฟล์เสร็จสิ้น! บันทึกเป็น project_context.txt แล้วครับ"
ls -lh project_context.txt
