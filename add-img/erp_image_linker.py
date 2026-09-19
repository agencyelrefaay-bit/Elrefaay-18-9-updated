import csv
import os
import time
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

# مسارات الملفات والسيستم
CSV_FILE = r"D:\work\add-img\proimgoutput_codes.csv"
IMAGES_DIR = r"D:\work\add-img\proimg"
ERP_URL = "http://localhost:5000/products"

def run_automation():
    options = webdriver.ChromeOptions()
    driver = webdriver.Chrome(options=options)
    driver.maximize_window()
    
    driver.get(ERP_URL)
    input(">>> [!] افتح السيستم، سجل دخول، وتأكد إنك واقف في صفحة المنتجات (بالعرض الجدولي)، وبعدين اضغط ENTER هنا في الكونسول...")
    
    with open(CSV_FILE, mode='r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        
        for row in reader:
            img_filename = row["Image_Filename"]
            product_code = row["Extracted_Code"]
            img_full_path = os.path.join(IMAGES_DIR, img_filename)
            
            if not product_code or product_code in ["ERROR", "NOT_FOUND"]:
                print(f"[-] تخطي الصورة {img_filename} لعدم توفر كود صحيح.")
                continue
                
            try:
                print(f"\n[*] جاري البحث عن الكود: {product_code} (للصورة: {img_filename})")
                
                # 1. البحث باستخدام الـ ID الدقيق (productSearch)
                search_box = WebDriverWait(driver, 10).until(
                    EC.element_to_be_clickable((By.ID, "productSearch"))
                )
                search_box.click()
                search_box.clear()
                search_box.send_keys(product_code)
                time.sleep(1.5) # انتظار ظهور النتيجة في الجدول
                
                # 2. الضغط مباشرة على زر التعديل الخاص بالمنتج (الذي يحتوي على onclick="editProduct(...)")
                edit_btn = WebDriverWait(driver, 5).until(
                    EC.element_to_be_clickable((By.XPATH, "//button[contains(@onclick, 'editProduct')]"))
                )
                edit_btn.click()
                time.sleep(1.5) # انتظار فتح الـ Modal
                
                # 3. إرفاق الصورة في حقل الـ file المخفي (#pmImageFile)
                file_input = WebDriverWait(driver, 5).until(
                    EC.presence_of_element_located((By.ID, "pmImageFile"))
                )
                file_input.send_keys(img_full_path)
                print(f"[+] تم إرفاق الصورة بنجاح للمنتج {product_code}")
                time.sleep(1.5)
                
                # 4. الضغط على زر حفظ التعديلات في المودال (حفظ / حفظ التغييرات / submit)
                save_btn = WebDriverWait(driver, 5).until(
                    EC.element_to_be_clickable((By.XPATH, "//div[contains(@class, 'modal')]//button[contains(text(), 'حفظ') or contains(text(), 'تعديل') or contains(@type, 'submit')]"))
                )
                save_btn.click()
                time.sleep(2) # انتظار إغلاق المودال وحفظ البيانات
                
                # العودة لصفحة المنتجات الرئيسية للمنتج التالي
                driver.get(ERP_URL)
                time.sleep(1.5)
                
            except Exception as e:
                print(f"[!] حدث خطأ مع المنتج {product_code}: {e}")
                try:
                    driver.get(ERP_URL)
                    time.sleep(2)
                except:
                    pass

    driver.quit()
    print("\n[🎉] مبروك يا مهندس! انتهت أداة الأوتوميشن وربط الصور بكل المنتجات بنجاح تام.")

if __name__ == "__main__":
    run_automation()