import { DataAwsAcmCertificate } from '@cdktf/provider-aws/lib/data-aws-acm-certificate';
import { Lb } from '@cdktf/provider-aws/lib/lb';
import { LbListener } from '@cdktf/provider-aws/lib/lb-listener';
import {
  LbListenerRule,
  LbListenerRuleCondition,
} from '@cdktf/provider-aws/lib/lb-listener-rule';
import { SecurityGroup } from '@cdktf/provider-aws/lib/security-group';
import { VpcSecurityGroupIngressRule } from '@cdktf/provider-aws/lib/vpc-security-group-ingress-rule';
import { Fn } from 'cdktf';

import { Construct } from 'constructs';

import { Vpc } from '../.gen/modules/vpc';
import { EnvironmentConfig, envDomain, subdomainForEnv } from '../utils';
import { allowAllEgressRule } from './security_group';

export class LoadBalancer extends Construct {
  lb: Lb;
  lbl: LbListener;
  vpc: Vpc;
  securityGroup: SecurityGroup;
  name: string;

  constructor(
    scope: Construct,
    name: string,
    vpc: Vpc,
    certificate: DataAwsAcmCertificate,
    environment: EnvironmentConfig,
  ) {
    super(scope, `${name}-load-balancer`);
    this.vpc = vpc;
    this.name = name;

    // Setup Security Group

    // Changing the security group config must be avoided as it will recreate it and almost everything depends on it
    // see https://registry.terraform.io/providers/hashicorp/aws/5.16.1/docs/resources/security_group#recreating-a-security-group
    this.securityGroup = new SecurityGroup(scope, `${name}-lb-security-group`, {
      name: `${name}-load-balancer`,
      vpcId: vpc.vpcIdOutput,
      lifecycle: {
        createBeforeDestroy: true, // see https://registry.terraform.io/providers/hashicorp/aws/5.16.1/docs/resources/security_group#recreating-a-security-group
      },
    });

    // Do not use the `ingress` and `egress` directly on the SecurityGroup for limitations reasons
    // See note on https://registry.terraform.io/providers/hashicorp/aws/5.16.1/docs/resources/security_group#protocol
    new VpcSecurityGroupIngressRule(this, `allow-http`, {
      cidrIpv4: '0.0.0.0/0',
      fromPort: 80,
      ipProtocol: 'tcp',
      securityGroupId: this.securityGroup.id,
      toPort: 80,
    });
    new VpcSecurityGroupIngressRule(this, `allow-http-ipv6`, {
      cidrIpv6: '::/0',
      fromPort: 80,
      ipProtocol: 'tcp',
      securityGroupId: this.securityGroup.id,
      toPort: 80,
    });
    new VpcSecurityGroupIngressRule(this, `allow-https`, {
      cidrIpv4: '0.0.0.0/0',
      fromPort: 443,
      ipProtocol: 'tcp',
      securityGroupId: this.securityGroup.id,
      toPort: 443,
    });
    new VpcSecurityGroupIngressRule(this, `allow-https-ipv6`, {
      cidrIpv6: '::/0',
      fromPort: 443,
      ipProtocol: 'tcp',
      securityGroupId: this.securityGroup.id,
      toPort: 443,
    });
    allowAllEgressRule(this, name, this.securityGroup.id);

    // Setup Load balancer

    this.lb = new Lb(this, `lb`, {
      name,
      internal: false,
      loadBalancerType: 'application',
      securityGroups: [this.securityGroup.id],
      subnets: Fn.tolist(vpc.publicSubnetsOutput),
      enableCrossZoneLoadBalancing: true,
    });

    new LbListener(this, `lb-listener-http-redirect`, {
      loadBalancerArn: this.lb.arn,
      port: 80,
      protocol: 'HTTP',
      defaultAction: [
        {
          redirect: { port: '443', protocol: 'HTTPS', statusCode: 'HTTP_301' },
          type: 'redirect',
        },
      ],
    });

    this.lbl = new LbListener(this, `lb-listener-https`, {
      loadBalancerArn: this.lb.arn,
      port: 443,
      protocol: 'HTTPS',
      defaultAction: [
        {
          redirect: {
            host: subdomainForEnv('maintenance', environment),
            protocol: 'HTTPS',
            statusCode: 'HTTP_302', // temporary redirect
          },
          type: 'redirect',
        },
      ],
      sslPolicy: 'ELBSecurityPolicy-2016-08',
      certificateArn: certificate.arn,
    });
  }

  addListenerRuleForHostRedirect(
    name: string,
    priority: number,
    redirectOptions: {
      subDomainTarget: string;
      subDomainOrigin: string;
      pathRewrite: string;
      queryRewrite?: string;
      statusCode?: string;
    },
    env: EnvironmentConfig,
    ruleConditions?: LbListenerRuleCondition[],
  ) {
    const host = redirectOptions.subDomainTarget
      ? subdomainForEnv(redirectOptions.subDomainTarget, env)
      : envDomain(env);

    new LbListenerRule(this, `${this.name}-${name}`, {
      listenerArn: this.lbl.arn,
      priority,
      action: [
        {
          type: 'redirect',
          redirect: {
            host,
            path: redirectOptions.pathRewrite,
            query: redirectOptions.queryRewrite,
            statusCode: redirectOptions.statusCode ?? 'HTTP_302',
            protocol: 'HTTPS',
          },
        },
      ],

      condition: [
        {
          hostHeader: {
            values: [subdomainForEnv(redirectOptions.subDomainOrigin, env)],
          },
        },
        ...(ruleConditions ?? []),
      ],
    });
  }
}
