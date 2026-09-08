import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const jsp = readFileSync('artifacts/offline-log-qr-generator.jsp', 'utf8').replace(/\r\n/g, '\n');
const code = (text, language = 'java') => '\n```' + language + '\n' + text.trim() + '\n```\n';
function method(name) {
  // Locate by the declaration line instead of a call site.
  const match = new RegExp('^([ \\t]*)public static [^\\n]+ ' + name + '\\([^\\n]*', 'm').exec(jsp);
  if (!match) throw new Error('Method not found: ' + name);
  const closing = '\n' + match[1] + '}';
  const end = jsp.indexOf(closing, match.index);
  if (end < 0) throw new Error('Method end not found: ' + name);
  return jsp.slice(match.index, end + closing.length);
}
function block(start, end) {
  const from = jsp.indexOf(start);
  const to = jsp.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error('Guide boundary not found: ' + start);
  return jsp.slice(from, to);
}
const buildMethods = block('public static List<QrPayload> buildPayloads(String log)', 'public static String gzipBase64Url');
const declarationStart = jsp.indexOf('<%!');
const declarationEnd = jsp.indexOf('%>', declarationStart);
if (declarationStart < 0 || declarationEnd < 0) throw new Error('JSP declaration not found');
const requestStart = jsp.indexOf('<%', declarationEnd + 2);
const requestEnd = jsp.indexOf('%>', requestStart);
if (requestStart < 0 || requestEnd < 0) throw new Error('JSP request block not found');
const requestBlock = jsp.slice(requestStart, requestEnd + 2);
const style = block('<style>', '</head>');
const player = block('<div class="player-area">', '<div class="payload-debug-list">');
const script = block('<script>', '</script>') + '</script>';
let guide = `# JSP 수동 반영 가이드 — Java 8 / 기존 ZXing / 최대 200장

기준은 대화에서 보내주신 **0.5초 재생 플레이어가 있는 JSP**입니다. GitHub의 예전 카드 나열형 JSP를 기준으로 찾을 필요는 없습니다.

완성본: [offline-log-qr-generator.jsp](../artifacts/offline-log-qr-generator.jsp)

아래 순서대로 기존 코드를 **교체**하세요. 같은 메서드나 script를 아래에 덧붙이면 중복 선언 또는 타이머 충돌이 생깁니다. 기존 파일은 별도 이름으로 보관한 뒤 시작하세요. 설명 문장은 입력하지 않고 코드 블록만 입력합니다. 들여쓰기는 달라도 되지만 따옴표, 역슬래시, 대소문자는 같아야 합니다.

추가 QR 라이브러리는 없습니다. 최신 JSP는 Java 8 기본 클래스인 WritableRaster와 MemoryCacheImageOutputStream을 import해서 사용합니다. 기존 파일에 아래 두 import가 없으면 추가하세요. 앞서 안내한 전체 클래스 이름을 사용하는 방식도 유효합니다. 검증용 scripts/tests/.test-deps는 WAS에 복사하지 않습니다.
` + code('<%@page import="java.awt.image.WritableRaster"%>\n<%@page import="javax.imageio.stream.MemoryCacheImageOutputStream"%>', 'jsp') + `

## 1. 상수 확인

기존 MAX_QR_COUNT의 50을 200으로 바꿉니다. MAX_SOURCE_BYTES는 보내주신 값인 1000000을 유지합니다. 나머지 값도 아래와 맞춥니다.
` + code(block('static final String RAW_PREFIX', 'static class QrPayload')) + `
한 장의 조각 길이는 1200자 그대로입니다. 디코더도 최대 200장, 해제 결과 1000000 bytes로 맞췄으므로 추후 이 두 한도를 늘릴 때는 디코더 protocol.js의 상수도 같이 변경해야 합니다.

## 2. QrPayload 생성자의 byteLength 한 줄 교체

기존 this.byteLength = utf8Length(text); 를 다음으로 교체합니다. RAW만 UTF-8 길이를 계산하고, ASCII로만 구성된 GZ/GZQR은 문자열 길이를 씁니다.
` + code('this.byteLength = "RAW".equals(mode) ? utf8Length(text) : text.length();') + `
## 3. escapeHtml 교체 / hasLogText 추가

기존 escapeHtml 메서드 전체를 아래 것으로 교체하고 바로 아래에 hasLogText를 추가합니다.
` + code(method('escapeHtml')) + code(method('hasLogText')) + `
작은따옴표의 case 줄에는 **역슬래시가 포함**됩니다. &를 바꾸는 줄과 작은따옴표 줄을 특히 확인하세요.

## 4. buildPayloads 2개를 아래 3개로 교체

기존 buildPayloads(String log), buildPayloads(String log, String groupId) 두 메서드를 모두 제거하고 아래 블록을 넣습니다. 새 byte[] 오버로드는 요청에서 만든 UTF-8 배열을 재사용합니다.
` + code(buildMethods) + `
200장이 넘으면 필요한 장수도 오류에 표시됩니다. 최종 payload 길이는 헤더를 포함해 매 조각 검사합니다.

## 5. gzipBase64Url 교체
` + code(method('gzipBase64Url')) + `
기존 canUseRawPayload, isDecoderTrimChar, utf8Length, createGroupId는 그대로 둬도 됩니다. normalizeGroupId 안의 StringBuilder 생성만 아래처럼 바꿉니다.
` + code('StringBuilder safe = new StringBuilder(32);') + `
## 6. createQrPngBase64 전체 교체

흑백 행 단위 기록, 메모리 PNG 출력, 흰 여백 4칸을 적용합니다. QrImage 클래스는 기존 것을 유지합니다.
` + code(method('createQrPngBase64')) + `
## 7. 요청 처리 scriptlet 전체 교체

선언부 <%! ... %> 다음에 있는 String submittedLog = request.getParameter("errorLog"); 로 시작하는 요청 처리 <% ... %> 블록을 다음으로 교체합니다. HTML 출력용 다른 <% ... %> 블록은 이 단계에서 건드리지 않습니다.
` + code(requestBlock, 'jsp') + `
request.setCharacterEncoding("UTF-8")는 getParameter보다 먼저 실행되어야 합니다. 앞단 필터가 이미 파라미터를 읽었다면 그 필터도 UTF-8이어야 합니다. 이때까지 반영한 뒤 기존 플레이어 상태로 저장/컴파일해도 됩니다.

## 8. head와 form 속성, 요약 표시 수정

head의 charset 다음에 아래 태그를 추가합니다(이미 있으면 중복 추가하지 않습니다).
` + code('<meta name="viewport" content="width=device-width, initial-scale=1">', 'html') + `
기존 form 시작 태그를 아래와 같이 바꿉니다.
` + code('<form method="post" action="" accept-charset="UTF-8">', 'html') + `
생성 결과 summary의 QR 개수 다음에 다음 줄을 추가하면 생성 시간을 비교할 수 있습니다.
` + code('<br>서버 생성 시간: <%= generationMs %> ms', 'jsp') + `
기존 style 블록 전체를 다음으로 교체합니다. 이미지 자체의 8px 검은 테두리를 없애고 바깥 qr-screen에 여백을 둡니다. 작은 화면에서는 QR 영역을 스크롤하며 원본 420px를 유지합니다. 브라우저 확대율 100%에서 확인하세요.
` + code(style, 'jsp') + `
## 9. player-area HTML 교체

기존 <div class="player-area">부터 그 영역의 닫는 </div>까지를 아래 블록으로 교체합니다. 다음에 나오는 payload-debug-list 영역은 유지합니다.
` + code(player, 'jsp') + `
이전/다음/번호 이동은 재생을 멈춘 상태에서 이동합니다. 멀티 QR 초기화는 디코더에서 새 로그를 읽을 때 사용합니다.

## 10. 플레이어 script 전체 교체

기존 var qrFrames = [ 로 시작하는 script 전체를 다음으로 교체합니다. 기존 setInterval, qrPayloadIndexes, qrPayloadTotals 배열은 새 블록과 함께 남겨두지 않습니다. script는 기존과 같이 QR이 생성된 경우에만 출력되는 if 블록 안에 둡니다.
` + code(script, 'jsp') + `
재생은 준비된 프레임을 표시한 뒤 다음 타이머를 예약합니다. JS가 유지하는 preload 객체는 현재/다음/다다음 최대 3개입니다. 브라우저 자체의 이미지 캐시는 별도입니다.

## 11. 직접 입력 후 확인 순서

1. 저장 인코딩 UTF-8 / Java 8 / 기존 ZXing JAR로 JSP가 열리는지 확인합니다.
2. 짧은 한글과 <>&를 입력합니다. RAW 한 장으로 생성되고 디코더 결과가 일치해야 합니다.
3. 앞 공백과 마지막 개행이 있는 짧은 로그를 입력합니다. GZ로 생성되고 공백이 유지되어야 합니다.
4. 50장이 넘던 로그를 입력합니다. 200장 이하면 생성되고, 넘으면 필요한 장수가 표시되어야 합니다.
5. QR 50번으로 이동, 이전/다음, 처음으로, 표시 시간 0.5/0.7/1/1.5초를 확인합니다.
6. 디코더에서 몇 장 받은 뒤 중지 → 이어서 스캔합니다. 받은 번호가 유지되어야 합니다. 새로고침하면 수집 상태는 지워집니다.
7. 빠진 번호를 확인해 JSP에서 해당 번호로 이동합니다. 복원이 끝나면 Copy Output으로 복사합니다.

타이핑 오류가 잦은 항목: byte[] 오버로드 누락, catch/finally의 중괄호, MemoryCacheImageOutputStream 철자, scriptlet의 <% %>, 쉼표를 출력하는 JSP 삼항식, 기존 script 중복입니다.

## 적용 범위와 검증 한계

200장은 항상 만드는 장수가 아니라 상한입니다. 입력의 압축 후 크기에 따라 실제 장수가 정해집니다. WAS/프록시의 POST 제한은 JSP의 100만 bytes와 별개이며 폼 URL 인코딩으로 요청 본문이 더 커질 수 있습니다. 실제 WAS 설정은 변경하지 않았습니다.

원문 검증 기준은 서버가 받은 문자열입니다. 브라우저 textarea/폼에 붙여넣기 전의 파일 바이트와는 개행 방식이 달라질 수 있습니다. 디코더의 정상 Copy Output 경로는 복원 문자열의 BOM과 CRLF를 유지하며, 권한 실패 후 수동 선택 복사에는 브라우저의 개행 정규화가 적용될 수 있습니다.

구체적인 실행 결과와 카메라 미검증 범위는 [검증 결과](VALIDATION.md)를 확인하세요.
`;
mkdirSync('docs', { recursive: true });
writeFileSync('docs/JSP-TYPING-GUIDE.md', guide);
console.log('docs/JSP-TYPING-GUIDE.md generated from the tested JSP blocks.');
