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
같은 조각을 다시 스캔하면 중복으로 무시합니다. 같은 번호의 조각인데 내용이 다르면 기존 조각을 덮어쓰지 않고 오류를 표시하므로, `멀티 QR 초기화` 후 같은 로그 묶음을 다시 스캔하세요.

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

## 대용량 로그와 JSP 생성기

- Java 8 / 기존 ZXing을 사용하는 [완성 JSP](artifacts/offline-log-qr-generator.jsp)
- 직접 입력할 때 보는 [한국어 수동 반영 가이드](docs/JSP-TYPING-GUIDE.md)
- 실행 환경, 성능 측정, 실기기 미검증 범위를 적은 [검증 결과](docs/VALIDATION.md)

JSP와 디코더는 최대 300장, 복원 결과 5,000,000 UTF-8 bytes를 지원합니다. 멀티 QR 스캔을 중지해도 받은 조각은 유지되며 이어서 스캔할 수 있습니다. 새로고침하면 수집 상태는 사라집니다. 새 로그는 멀티 QR 초기화 후 스캔하세요.

누락 번호를 복사해 JSP에서 해당 번호로 이동하거나, QR payload를 한 조각씩 입력창에 붙여넣고 Decode를 눌러 수집할 수 있습니다. Copy Output은 복원 문자열을 사용하여 textarea 표시 과정에서 정규화되는 CRLF도 유지합니다.

검증 명령과 필요한 테스트 전용 도구는 검증 결과 문서에 설명했습니다. 검증 JAR, Node, 브라우저 자동화 도구는 인트라넷 JSP 배포에 필요하지 않습니다.

300장/5MB는 단독 사용자의 263장 생성 사례에 맞춘 설정입니다. 실제 WAS 동시 부하나 휴대폰 최대 처리량을 보장하는 안전 상한은 아닙니다. 업데이트 후 페이지를 새로고침하고 '최대 300장 · 복원 최대 5MB' 안내가 보이는지 확인하세요.
