import { NextAuthOptions, User as NextAuthUser } from "next-auth";
import { OAuthConfig } from "next-auth/providers/oauth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

// Ensure global prisma instance in development
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };
const prisma = globalForPrisma.prisma || new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

// Build providers list
const providers: NextAuthOptions["providers"] = [
  CredentialsProvider({
    name: "Credentials",
    credentials: {
      username: { label: "Tài khoản", type: "text", placeholder: "admin" },
      password: { label: "Mật khẩu", type: "password" },
    },
    async authorize(credentials) {
      if (!credentials?.username || !credentials?.password) {
        throw new Error("Vui lòng nhập tài khoản và mật khẩu");
      }

      const user = await prisma.user.findUnique({
        where: { username: credentials.username },
      });

      if (!user) {
        throw new Error("Tài khoản không tồn tại");
      }

      if (!user.password) {
        throw new Error("Tài khoản này sử dụng đăng nhập SSO");
      }

      const isPasswordValid = await bcrypt.compare(
        credentials.password,
        user.password
      );

      if (!isPasswordValid) {
        throw new Error("Mật khẩu không chính xác");
      }

      return {
        id: user.id,
        username: user.username,
        role: user.role,
        name: user.username,
      };
    },
  }),
];

// Conditionally add OIDC provider
if (process.env.NEXT_PUBLIC_OIDC_ENABLED === "true" && process.env.OIDC_ISSUER) {
  const oidcProvider: OAuthConfig<{ sub: string; preferred_username?: string; email?: string; name?: string }> = {
    id: "oidc",
    name: "SSO",
    type: "oauth",
    wellKnown: `${process.env.OIDC_ISSUER}/.well-known/openid-configuration`,
    clientId: process.env.OIDC_CLIENT_ID!,
    clientSecret: process.env.OIDC_CLIENT_SECRET!,
    authorization: { params: { scope: "openid email profile" } },
    idToken: true,
    checks: ["pkce", "state"],
    profile(profile) {
      return {
        id: profile.sub,
        username: profile.preferred_username || profile.email || profile.sub,
        role: "",
        name: profile.name || profile.preferred_username || profile.sub,
        email: profile.email,
      };
    },
  };
  providers.push(oidcProvider);
}

export const authOptions: NextAuthOptions = {
  providers,
  callbacks: {
    async signIn({ user, account }) {
      if (account?.provider === "oidc") {
        const sub = account.providerAccountId;

        let dbUser = await prisma.user.findUnique({
          where: { providerSub: sub },
        });

        if (!dbUser) {
          // JIT provision: create user with VIEWER role
          const baseUsername = (user as NextAuthUser & { username?: string }).username
            || user.email
            || sub;
          let username = baseUsername;
          let suffix = 1;
          while (await prisma.user.findUnique({ where: { username } })) {
            username = `${baseUsername}_${suffix++}`;
          }

          dbUser = await prisma.user.create({
            data: {
              username,
              password: "",
              role: "VIEWER",
              provider: "oidc",
              providerSub: sub,
              email: user.email || null,
              displayName: user.name || null,
            },
          });
        } else {
          // Update display info from IDP on each login
          await prisma.user.update({
            where: { id: dbUser.id },
            data: {
              email: user.email || dbUser.email,
              displayName: user.name || dbUser.displayName,
            },
          });
        }

        // Attach DB identity so jwt callback picks it up
        user.id = dbUser.id;
        (user as NextAuthUser & { username: string }).username = dbUser.username;
        (user as NextAuthUser & { role: string }).role = dbUser.role;
      }
      return true;
    },
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.username = (user as NextAuthUser & { username: string }).username;
        token.role = (user as NextAuthUser & { role: string }).role;
      }
      return token;
    },
    async session({ session, token }) {
      if (token) {
        session.user = {
          ...session.user,
          id: token.id as string,
          username: token.username as string,
          role: token.role as string,
        };
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
  },
  secret: process.env.NEXTAUTH_SECRET,
};
