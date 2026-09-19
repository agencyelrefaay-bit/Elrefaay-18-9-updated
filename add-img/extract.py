import os
import csv
import re
import easyocr
from PIL import Image
from tqdm import tqdm

IMAGE_FOLDER = r"D:\work\add-img\proimg"
OUTPUT_CSV = r"D:\work\add-img\proimgoutput_codes.csv"

def extract_codes():
    print("[*] Initializing Advanced OCR Reader...")
    # تهيئة الـ reader
    reader = easyocr.Reader(['en'], gpu=True)
    
    supported_extensions = ('.png', '.jpg', '.jpeg', '.webp')
    images = [f for f in os.listdir(IMAGE_FOLDER) if f.lower().endswith(supported_extensions)]
    
    print(f"[*] Found {len(images)} images to process.")
    results = []
    
    for img_name in tqdm(images, desc="Processing OCR"):
        img_path = os.path.join(IMAGE_FOLDER, img_name)
        try:
            with Image.open(img_path) as img:
                width, height = img.size
                
                # اختياري: لو الكود مكانه ثابت غالباً (مثلاً في ربع الصورة التحتاني الشمال)
                # ممكن نعمل Crop للصورة عشان نزيل اللوجو الخلفي ونضمن سرعة ودقة أعلى:
                # box = (0, int(height * 0.75), int(width * 0.4), height)
                # cropped_img = img.crop(box)
                # cropped_path = "temp_crop.jpg"
                # cropped_img.save(cropped_path)
                # ocr_results = reader.readtext(cropped_path, detail=0)
                
                # أو قراءة الصورة بالكامل مع فلترة الذكاء الاصطناعي للأكواد:
                ocr_results = reader.readtext(img_path, detail=0)
            
            # الدمج للبحث عن النمط المطلوب
            full_text = " ".join(ocr_results)
            
            # استخدام Regular Expression (Regex) للبحث عن نمط الكود (مثلاً أرقام بعدها شرطة وحروف زي 9262-GD)
            # النمط ده بيلقط أي رقم متبوع بشرطة وحروف أو أرقام انجليزية
            code_pattern = r'\b\d+[\w-]*\b'
            found_codes = re.findall(code_pattern, full_text)
            
            # استبعاد الكلمات الشائعة لو ظهرت بالخطأ (مثل اسم الشركة لو قرأه بالعربي أو الإنجليزي)
            valid_code = "NOT_FOUND"
            for c in found_codes:
                # نتأكد إن الكود فيه أرقام (لأن أكواد النجف لازم تبدأ برقم)
                if any(char.isdigit() for char in c) and len(c) > 2:
                    valid_code = c.upper()
                    break
            
            # لو لم يجد بالنمط، ناخذ أول نتيجة واضحة
            if valid_code == "NOT_FOUND" and ocr_results:
                valid_code = ocr_results[0].strip().upper()

            results.append({
                "Image_Filename": img_name,
                "Extracted_Code": valid_code
            })
            
        except Exception as e:
            print(f"\n[!] Error processing {img_name}: {e}")
            results.append({
                "Image_Filename": img_name,
                "Extracted_Code": "ERROR"
            })
            
    # حفظ النتائج
    with open(OUTPUT_CSV, mode='w', newline='', encoding='utf-8-sig') as csv_file:
        fieldnames = ["Image_Filename", "Extracted_Code"]
        writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
        writer.writeheader()
        for row in results:
            writer.writerow(row)
            
    print(f"\n[+] Done! Exported clean codes to: {OUTPUT_CSV}")

if __name__ == "__main__":
    extract_codes()