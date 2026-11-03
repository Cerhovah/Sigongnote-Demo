import { ApiErrorSchema, type ErrorCode, type ApiError } from "./schemas.js";
export const ERROR_CATALOG = {
 STORAGE_QUOTA_EXCEEDED:[409,"내 계정의 자료 처리 한도 100GB에 도달했어요. 새 전송을 멈추고 기존 자료는 보존합니다.",false],
 INVALID_CONTRACT:[400,"입력 형식을 확인해 주세요.",false],
 UNAUTHENTICATED:[401,"다시 로그인해 주세요.",false],
 FORBIDDEN:[403,"이 작업을 할 권한이 없습니다.",false],
 NOT_FOUND:[404,"자료를 찾을 수 없습니다.",false],
 VERSION_CONFLICT:[409,"다른 기기에서 내용이 바뀌었습니다. 바뀐 내용을 확인해 주세요.",false],
 IDEMPOTENCY_CONFLICT:[409,"이 요청의 내용이 변경되었습니다. 다시 확인해 주세요.",false],
 SOURCE_EXPIRED:[410,"자료 연결이 만료되었습니다. 다시 연결해 주세요.",false],
 PAYLOAD_TOO_LARGE:[413,"파일이 허용 크기를 넘었습니다.",false],
 UNSUPPORTED_MEDIA:[415,"아직 지원하지 않는 파일 형식입니다.",false],
 SOURCE_SCOPE_MISMATCH:[422,"이 연결에서 받을 자료가 아닙니다. 자료 종류에 맞는 연결을 선택해 주세요.",false],
 DOMAIN_INVARIANT:[422,"내용을 확인한 뒤 다시 시도해 주세요.",false],
 RATE_LIMITED:[429,"잠시 후 다시 시도해 주세요.",true],
 TEMPORARILY_UNAVAILABLE:[503,"일시적으로 연결되지 않습니다. 잠시 후 다시 시도해 주세요.",true],
} as const satisfies Record<ErrorCode,readonly [number,string,boolean]>;
export function makeApiError(code:ErrorCode,correlationId:string,details?:ApiError["error"]["details"]) {
 const [status,message,retryable]=ERROR_CATALOG[code];
 const body=ApiErrorSchema.parse({error:{code,message_ko:message,retryable,correlation_id:correlationId,...(details ? {details} : {})}});
 return {status,body};
}
