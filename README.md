# QR GZIP Decoder

GitHub Pages에서 실행하는 모바일용 QR 로그 디코더입니다.

## 지원 포맷

단일 원문:

```text
RAW:<plain text>
```

단일 GZIP:

```text
GZ:<base64url gzip payload>
```

멀티 GZIP:

```text
GZQR:v1:<id>:<index>:<total>:<chunk>
```

예시:

```text
GZQR:v1:260616134652:1:3:AAAA
GZQR:v1:260616134652:2:3:BBBB
GZQR:v1:260616134652:3:3:CCCC
```

멀티 QR은 아무 순서로 스캔해도 됩니다. 모든 조각이 모이면 페이지가 자동으로 `GZ:` 입력값을 조립하고 GZIP 해제를 시도합니다.

## 브라우저 권장

- Android Chrome 권장
- HTTPS GitHub Pages 권장
- 카카오톡 인앱 브라우저에서는 카메라 권한이 막힐 수 있으므로 Chrome에서 열어야 합니다.

## 개인정보 처리

이 페이지는 정적 HTML/JS/CSS만 제공합니다. QR 스캔, 조각 조립, GZIP 해제는 브라우저 안에서만 처리하며 서버로 로그를 전송하지 않습니다.

## 개발 확인

```bash
npm test
```
