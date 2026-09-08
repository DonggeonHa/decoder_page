# 검증 결과 — 2026-09-08

## 적용 범위

- 운영용 JSP: Java 8, 기존 ZXing import 4개 유지. 추가 QR 라이브러리 없음.
- 원문 한도 1,000,000 UTF-8 bytes / 최대 200장 / 조각 1,200자 / 헤더 포함 payload 최대 1,500 bytes.
- RAW/GZ/GZQR v1 형식 유지. 기존 생성 JSP의 QR도 디코더에서 처리 가능.
- 픽셀 행 단위 기록, 단일 UTF-8 배열 재사용, 단일 순회 HTML escaping, 명시적인 메모리 PNG 출력.
- QR 흰 여백 4칸, 원본 420px 표시, 0.5/0.7/1/1.5초 재생, 번호 이동, 현재와 다음 두 프레임만 미리 준비.
- 디코더: 중지 후 수집 재개, 누락 번호 복사, 조각 붙여넣기, 선두 BOM/CRLF 복사 보존, 최대 해제 크기 검사, 늦게 끝난 카메라 요청/인식 무시.

## 실제 사용한 검증 환경

- Windows 홈서버, Temurin OpenJDK 1.8.0_492, Node.js 24.18.0.
- QR 검증용 ZXing core/javase 3.5.3.
- JSP 실행 검증용 embedded Tomcat 9.0.115 + ECJ 3.26.0, 127.0.0.1 임시 포트.
- 설치된 Microsoft Edge의 headless 브라우저.
- 검증용 JAR은 .test-deps에만 저장하며 Git 및 인트라넷 전달 대상에서 제외.

## 검증 항목

1. Node/Java 코어 회귀 테스트 17개: RAW/GZ 분기, 공백, BOM, 잘못된 UTF-8, 해제 크기, 중복/충돌/누락, 200장, 카메라 취소/종료.
2. Java 8: 800/801 byte RAW 경계, 6만 자의 압축이 잘 안 되는 입력, 정확히 200장 허용, 200장 초과 및 원문 100만 bytes 초과 거절, HTML escaping.
3. PNG 202개(단일 RAW/GZ 각 1개, 멀티 200개)의 모든 픽셀이 ZXing BitMatrix와 일치하는지 검사하고 payload 데이터 복원.
4. Java가 만든 5개 fixture를 실제 JavaScript 디코더로 복원. 선두 BOM/공백/한글/CRLF/마지막 개행과 역순 200개 조각 포함.
5. 실제 JSP GET/POST: 한글 포함 6만 자 요청 → 56장 생성, UTF-8 입력 유지, 420px 표시, 50번 이동, 속도 변경, 일시정지, preload 최대 3개.
6. 실제 브라우저 UI: 조각 1개 수집 → 중지 → 이어서 수집 → 복원, 누락 번호 복사, 조각 붙여넣기, Copy Output의 BOM/CRLF 유지.

## 중요한 카메라 검증 한계

202개 PNG 중 5개는 ZXing 기본 위치 탐색에서 인식에 실패했습니다. 그 5개는 기존 생성 함수가 만든 이미지와 픽셀이 완전히 같아 이번 픽셀 기록 변경으로 생긴 차이는 아닙니다. 위치를 알고 있는 이미지용 PURE_BARCODE 옵션에서는 데이터를 복원했습니다. 따라서 이 결과를 자동 탐색 202/202 성공 또는 휴대폰 인식률 100%로 해석하면 안 됩니다.

브라우저 검증에서는 카메라/BarcodeDetector 입력과 클립보드 전송만 테스트용으로 대체했습니다. 앱의 수집/재개/복원/UI는 실제 코드를 실행했습니다. 휴대폰의 광학 인식, 초점, 조명, 모니터 배율, 화면 전환 중 인식률은 실기기 확인이 필요합니다.

실제 인트라넷 WAS와 그곳에 설치된 ZXing 버전은 확인하지 않았습니다. 이 결과는 위 버전에서의 검증입니다. WAS/프록시 POST 제한도 별도입니다.

## 성능 측정

기존 기준 커밋: c3d4113dd5ba7999adfd2b2fccb4336f7b4f79be.

같은 1,200자 조각의 QR 20종으로 Java 8에서 각 버전 60장 워밍업 후, 20장씩 7회(총 140장/버전) 측정했습니다. 기존/개선 순서를 번갈아 실행하고 회차별 한 장당 시간의 중앙값을 비교했습니다.

| 측정 대상 | 기존 | 개선 |
|---|---:|---:|
| ZXing 인코딩 + 이미지 기록 + PNG + Base64 | 9.036 ms/장 | 5.693 ms/장 |

이 측정 구간은 약 37% 감소(처리 속도 약 1.59배)했습니다. GZIP, 전체 JSP 요청, 네트워크, 카메라 스캔을 포함한 속도가 아닙니다. 단일 홈서버의 합성 데이터 결과이며 실제 WAS에서 같은 개선율을 보장하지 않습니다.

## 재실행

검증 PC에 JDK 8과 Node.js를 준비하고 JAVA_HOME을 설정합니다. Java 8/ZXing 외의 아래 도구들은 테스트 PC에만 필요합니다.

```text
npm test
npm run test:deps
npm run test:java
npm run test:browser
node scripts/benchmark.mjs
```

브라우저 검증에는 테스트 PC의 Playwright 패키지와 Edge(기본값)가 필요합니다. PLAYWRIGHT_MODULE로 설치된 패키지 위치를, BROWSER_CHANNEL로 사용할 채널을 지정할 수 있습니다. npm run test:deps는 공식 Maven Central에서 검증용 JAR을 받고 체크섬을 대조합니다.

타이핑 가이드를 다시 만들려면 node scripts/build-typing-guide.mjs를 실행합니다. 가이드의 코드 블록은 검증된 완성 JSP에서 추출됩니다.
