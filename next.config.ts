import type { NextConfig } from 'next';
const nextConfig:NextConfig={
  poweredByHeader:false,
  reactStrictMode:true,
  serverExternalPackages:['knex','mysql2','nodemailer','imapflow','mailparser','sanitize-html'],
  webpack(configuration){
    configuration.resolve.extensionAlias={...configuration.resolve.extensionAlias,'.js':['.ts','.tsx','.js']};
    return configuration;
  },
  async headers(){return [{source:'/:path*',headers:[
    {key:'X-Content-Type-Options',value:'nosniff'},
    {key:'X-Frame-Options',value:'DENY'},
    {key:'Referrer-Policy',value:'no-referrer'},
    {key:'Permissions-Policy',value:'camera=(), microphone=(), geolocation=()'},
  ]}];},
};
export default nextConfig;
