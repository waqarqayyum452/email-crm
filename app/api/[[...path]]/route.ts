import { handleRequest } from '../../../server/app';
export const runtime='nodejs';
export const dynamic='force-dynamic';
const route=(request:Request)=>handleRequest(request);
export { route as GET,route as HEAD,route as POST,route as PATCH,route as PUT,route as DELETE,route as OPTIONS };
