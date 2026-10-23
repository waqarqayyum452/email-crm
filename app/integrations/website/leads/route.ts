import { handleRequest } from '../../../../server/app';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const POST=(request:Request)=>handleRequest(request);
