# MULTI-AGENT INSTRUCTIONS FOR CODEX

Hệ thống đang chạy qua Local Multi-Key Router trung gian tại http://127.0.0.1:5050 kết nối với pool nhiều API Key độc lập:
- Lead Agent: Dùng Key chính với model `gpt-6.1-sol (Max)` để trao đổi trực tiếp với người dùng.
- Subagents: Được Router tự động cấp phát các Key phụ riêng biệt với reasoning `XHigh` chạy song song 100%, không bị nghẽn Concurrency.

## NGUYÊN TẮC THỰC THI (MULTI-AGENT FIRST):
1. **Phân rã tác vụ (Task Decomposition):** Với mọi task kỹ thuật (rà soát, kiểm tra tiến độ, phân tích code, viết logic, chạy test), Lead Agent TUYỆT ĐỐI KHÔNG làm một mình tuần tự. Phải tự động chia nhỏ việc và khởi chạy ít nhất 2–3 Subagents chạy ngầm song song (Search/Explorer, Code Analyzer, Quality Tester).
2. **Kênh chat không chặn (Non-blocking Chat):** Trong lúc các Subagents đang xử lý trong nền trên các API Key phụ, Lead Agent vẫn phải phản hồi người dùng ngay lập tức, tóm tắt bước đầu và sẵn sàng nhận lệnh mới mà không bắt người dùng phải chờ đợi.
3. **Báo cáo tổng hợp:** Khi các Subagent hoàn tất, Lead Agent tổng hợp kết quả súc tích, chỉ rõ file:dòng và đề xuất bước tiếp theo.
