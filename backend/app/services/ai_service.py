import json
from typing import AsyncGenerator
from openai import AsyncOpenAI
from app.config import settings

SYSTEM_PROMPT = """Bạn là chuyên gia hiệu đính và dịch thuật tiếng Việt. Hãy sửa và làm sạch đoạn văn dịch tiếng Việt theo các quy tắc:
1. Sửa tên riêng: chuyển tên nhân vật/địa danh chưa dịch (tiếng Trung/Anh/Nhật) sang phiên âm tiếng Việt chuẩn
2. Cải thiện câu văn: sửa ngữ pháp, loại bỏ câu dịch máy gượng gạo, làm văn xuôi tự nhiên hơn
3. Giữ nguyên nội dung: không thay đổi ý nghĩa, không thêm hoặc bớt chi tiết
4. Định dạng đúng: mỗi đoạn văn tách nhau bằng một dòng trống, không dùng số thứ tự đoạn
5. Làm sạch: xóa ký tự thừa, khoảng trắng dư, dấu câu lặp, ký tự rác từ EPUB

Chỉ trả về văn bản đã sửa, không có lời giải thích, nhận xét hay tiêu đề."""


async def stream_ai_fix(text: str) -> AsyncGenerator[str, None]:
    """Stream GPT-fixed Vietnamese text as SSE chunks."""
    client = AsyncOpenAI(api_key=settings.openai_api_key)

    stream = await client.chat.completions.create(
        model=settings.openai_model,
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
