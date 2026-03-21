import json
from typing import AsyncGenerator
from openai import AsyncOpenAI
from app.config import settings

SYSTEM_PROMPT = """Bạn là chuyên gia hiệu đính truyện tiên hiệp/võ hiệp Trung Quốc dịch sang tiếng Việt. Hãy sửa và làm sạch đoạn văn theo các quy tắc:
1. Đại từ nhân xưng: dùng "ta" thay cho "tôi" cho ngôi thứ nhất; giữ các đại từ cổ phong như "ngươi", "hắn", "nàng", "lão", "tiểu", "bổn tọa", v.v. đúng ngữ cảnh xưng hô võ hiệp/tiên hiệp
2. Sửa tên riêng: giữ nguyên hoặc phiên âm Hán-Việt cho tên nhân vật, môn phái, địa danh, công pháp, vũ khí — ưu tiên phong cách Hán-Việt cổ điển (ví dụ: "Thiên Long", "Huyền Thiết kiếm", "Ngự Kiếm thuật")
3. Giữ văn phong tiên hiệp/võ hiệp: câu văn trang trọng, hào sảng; giữ các cụm từ đặc trưng như "đột phá cảnh giới", "linh khí", "tu vi", "đan điền", "kinh mạch"
4. Cải thiện câu văn: sửa ngữ pháp, loại bỏ câu dịch máy gượng gạo, làm văn xuôi tự nhiên và đúng thể loại
5. Giữ nguyên nội dung: không thay đổi ý nghĩa, không thêm hoặc bớt chi tiết
6. Định dạng đúng: mỗi đoạn văn tách nhau bằng một dòng trống, không dùng số thứ tự đoạn
7. Làm sạch: xóa ký tự thừa, khoảng trắng dư, dấu câu lặp, ký tự rác từ EPUB

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
