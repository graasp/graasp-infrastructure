#!/usr/bin/env bash

function show_help() {
    echo "This script allows to deploy a new version of the graasp ecs service and push the docker images for the core and the migration"
    echo "Usage: bash docker/build.sh ECR_URI VERSION"
    echo "Arguments:"
    echo "  PUBLIC_ECR_URI       URI of the ECR in AWS, example: public.ecr.aws/qzuer78"
    echo "  PRIVATE_ECR_URI      URI of the ECR in AWS, example: 17328471928347.dkr.ecr.eu-central-1.amazonaws.com"
    echo "  VERSION              The version that is deployed, should be a semantic version i.e 1.45.8"
    echo "  REGION               The AWS region that the PRIVATE_ECR is deployed to. for example: eu-central-1"
    echo "  CLUSTER_NAME         The AWS cluster name to deploy to example: graasp-dev"
}

# Check if no arguments are provided
if [ "$#" -eq 0 ]; then
    show_help
    exit 1
fi

# Get inputs from command line
if [ -z "$1" ]; then
  echo "Missing required PUBLIC_ECR_URI argument"
  exit 1
fi
public_ecr_uri=$1

if [ -z "$2" ]; then
  echo "Missing required PRIVATE_ECR_URI argument"
  exit 1
fi
private_ecr_uri=$2

if [ -z "$3" ]; then
  echo "Missing required VERSION argument"
  exit 1
fi
tag_version=$3

if [ -z "$4" ]; then
  echo "Missing required REGION argument"
  exit 1
fi
region=$4

if [ -z "$5" ]; then
  echo "Missing required CLUSTER_NAME argument"
  exit 1
fi
cluster_name=$5

core_image_tag=core-$tag_version
public_ecr_image=docker://$public_ecr_uri/graasp:$core_image_tag
image_tag=docker://$private_ecr_uri/graasp:core-latest

# Check if the aws cli is authenticated
aws_identity=$(aws sts get-caller-identity)
if [ $? -eq 0 ]; then
  echo -e "Using AWS identity:\n$aws_identity"
else
  echo "AWS CLI is not authenticated, please ensure the cli is authenticated before running this script";
  exit 1
fi

ecr_credentials=$(aws ecr get-login-password --region $region)
if [ -z $ecr_credentials ]; then
  echo "The AWS credentials were not received"
  echo "Please check that the PRIVATE_ECR_URI is correct and that you are logged into an account or role that is allowed to use that ECR"
  exit 1
fi
# login the docker client with the ECR credentials derived from the currently authenticated user
echo $ecr_credentials | skopeo login --username AWS --password-stdin $private_ecr

# copy
skopeo --override-os linux copy --multi-arch all $public_ecr_image $image_tag

# force a new deployment of the cluster
aws ecs update-service --cluster $cluster_name --service graasp --force-new-deployment


# private_ecr=${{ secrets.AWS_ACCOUNT_ID }}.dkr.ecr.${{ vars.AWS_REGION }}.amazonaws.com
