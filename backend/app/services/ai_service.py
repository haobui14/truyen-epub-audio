import json
from typing import AsyncGenerator
from openai import AsyncOpenAI
from app.config import settings

SYSTEM_PROMPT = """Bạn là chuyên gia hiệu đính truyện tiên hiệp/võ hiệp Trung Quốc dịch sang tiếng Việt. Văn bản đã sửa sẽ được ĐỌC THÀNH TIẾNG bằng TTS tiếng Việt — vì vậy mọi quyết định phải tính đến cách phát âm, không chỉ cách viết.

Hãy sửa và làm sạch đoạn văn theo các quy tắc:

1. Đại từ nhân xưng: dùng "ta" thay cho "tôi" cho ngôi thứ nhất; giữ các đại từ cổ phong như "ngươi", "hắn", "nàng", "lão", "tiểu", "bổn tọa", v.v. đúng ngữ cảnh xưng hô võ hiệp/tiên hiệp.

2. Tên riêng — CỰC KỲ QUAN TRỌNG vì TTS sẽ đọc to:
   a. Chuyển TẤT CẢ ký tự Hán (汉字 / 漢字) còn sót lại sang phiên âm Hán-Việt; tuyệt đối không để chữ Trung Quốc trong văn bản ra.
   b. Mỗi nhân vật / môn phái / địa danh / công pháp / pháp bảo / vũ khí chỉ dùng MỘT cách viết duy nhất xuyên suốt chương. Nếu nguyên bản có nhiều cách viết khác nhau cho cùng một thực thể, chọn một dạng và áp dụng nhất quán.
   c. Khi một tên có nhiều cách phiên âm Hán-Việt, ưu tiên dạng phổ biến, dễ đọc, hợp phong cách cổ điển (ví dụ: "Thiên Long", "Huyền Thiết kiếm", "Ngự Kiếm thuật").
   d. Phiên âm, KHÔNG dịch nghĩa: "Lý Phong" giữ là "Lý Phong", không đổi thành "Gió Lý".

3. Đọc lên phải xuôi tai (TTS-friendly):
   a. Chuyển số/chữ số thành chữ tiếng Việt khi chúng nằm trong tên riêng hoặc danh hiệu (ví dụ "Đường III" → "Đường đệ tam", "đệ tử số 7" → "đệ tử số bảy").
   b. Thay thế từ tiếng Anh/ngoại ngữ lạc lõng bằng tiếng Việt hoặc Hán-Việt tương đương; chỉ giữ lại nếu thật sự là danh từ riêng.
   c. Xoá ký tự trang trí, hoa thị, dấu câu lặp, ký hiệu unicode lạ — bất cứ thứ gì TTS sẽ đọc nguyên văn thành tiếng vô nghĩa.
   d. Chuyển số La Mã gắn với tên riêng thành số thứ tự Hán-Việt ("Vương quốc Đại Đường II" → "Vương quốc Đại Đường đệ nhị").
   e. Không dùng từ viết tắt mà TTS sẽ đọc sai.

4. Giữ văn phong tiên hiệp/võ hiệp: câu văn trang trọng, hào sảng; giữ các cụm từ đặc trưng như "đột phá cảnh giới", "linh khí", "tu vi", "đan điền", "kinh mạch".

5. Cải thiện câu văn: sửa ngữ pháp, loại bỏ câu dịch máy gượng gạo, làm văn xuôi tự nhiên và đúng thể loại.

6. Giữ nguyên nội dung: không thay đổi ý nghĩa, không thêm hoặc bớt chi tiết.

7. Định dạng đúng: mỗi đoạn văn tách nhau bằng một dòng trống, không dùng số thứ tự đoạn.

8. Làm sạch: xoá ký tự thừa, khoảng trắng dư, dấu câu lặp, ký tự rác từ EPUB.

TRƯỚC KHI TRẢ LỜI: đọc lại bản sửa trong đầu như đang nghe TTS đọc. Nếu một cái tên xuất hiện hai lần với hai cách viết khác nhau, thống nhất lại. Nếu một câu nghe rối khi đọc to, viết lại cho rõ.

Chỉ trả về văn bản đã sửa, không có lời giải thích, nhận xét hay tiêu đề."""

# GPT-5+ uses the Responses API; older models use Chat Completions
_RESPONSES_API_PREFIXES = ("gpt-5", "o1", "o3", "o4")


def _use_responses_api(model: str) -> bool:
    return any(model.startswith(p) for p in _RESPONSES_API_PREFIXES)


async def stream_ai_fix(text: str) -> AsyncGenerator[str, None]:
    """Stream GPT-fixed Vietnamese text as SSE chunks."""
    client = AsyncOpenAI(api_key=settings.openai_api_key)
    model = settings.openai_model

    if _use_responses_api(model):
        # Responses API — required for GPT-5 and above
        stream = await client.responses.create(
            model=model,
            input=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": text},
            ],
            stream=True,
            max_output_tokens=16000,
        )
        async for event in stream:
            if event.type == "response.output_text.delta":
                delta = event.delta
                if delta:
                    yield f"data: {json.dumps({'text': delta})}\n\n"
    else:
        # Chat Completions API — GPT-4 and below
        stream = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": text},
            ],
            stream=True,
            max_tokens=16000,
            temperature=0.3,
        )
        async for chunk in stream:
            delta = chunk.choices[0].delta.content
            if delta:
                yield f"data: {json.dumps({'text': delta})}\n\n"

    yield "data: [DONE]\n\n"
